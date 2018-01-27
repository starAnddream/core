/**
 * @abstract
 */
class BaseChain extends IBlockchain {
    /**
     * @param {ChainDataStore} store
     */
    constructor(store) {
        super();
        this._store = store;
    }

    /**
     * @param {Hash} hash
     * @param {boolean} [includeForks]
     * @returns {Promise.<?Block>}
     */
    async getBlock(hash, includeForks = false) {
        const chainData = await this._store.getChainData(hash);
        return chainData && (chainData.onMainChain || includeForks) ? chainData.head : null;
    }

    /**
     * @param {number} height
     * @returns {Promise.<?Block>}
     */
    getBlockAt(height) {
        return this._store.getBlockAt(height) || null;
    }

    /**
     * @param {number} height
     * @param {boolean} [lower]
     * @returns {Promise.<?Block>}
     */
    getNearestBlockAt(height, lower=true) {
        return this._store.getNearestBlockAt(height, lower) || null;
    }

    /**
     * Computes the target value for the block after the given block or the head of this chain if no block is given.
     * @param {Block} [block]
     * @returns {Promise.<number>}
     */
    async getNextTarget(block) {
        /** @type {ChainData} */
        let headData;
        if (block) {
            const hash = await block.hash();
            headData = await this._store.getChainData(hash);
            Assert.that(!!headData);
        } else {
            block = this.head;
            headData = this._mainChain;
        }

        // Retrieve the timestamp of the block that appears DIFFICULTY_BLOCK_WINDOW blocks before the given block in the chain.
        // The block might not be on the main chain.
        const tailHeight = Math.max(block.height - Policy.DIFFICULTY_BLOCK_WINDOW, 1);
        /** @type {ChainData} */
        let tailData;
        if (headData.onMainChain) {
            tailData = await this._store.getChainDataAt(tailHeight);
        } else {
            let prevData = headData;
            for (let i = 0; i < Policy.DIFFICULTY_BLOCK_WINDOW && !prevData.onMainChain; i++) {
                prevData = await this._store.getChainData(prevData.head.prevHash);
                if (!prevData) {
                    // Not enough blocks are available to compute the next target, fail.
                    return -1;
                }
            }

            if (prevData.onMainChain && prevData.head.height > tailHeight) {
                tailData = await this._store.getChainDataAt(tailHeight);
            } else {
                tailData = prevData;
            }
        }

        if (!tailData || tailData.totalDifficulty < 1) {
            // Not enough blocks are available to compute the next target, fail.
            return -1;
        }

        const deltaTotalDifficulty = headData.totalDifficulty - tailData.totalDifficulty;
        return BlockUtils.getNextTarget(headData.head.header, tailData.head.header, deltaTotalDifficulty);
    }

    /**
     * @returns {Promise.<Array.<Hash>>}
     */
    async getBlockLocators() {
        // Push top 10 hashes first, then back off exponentially.
        /** @type {Array.<Hash>} */
        const locators = [this.headHash];

        let block = this.head;
        for (let i = Math.min(10, this.height) - 1; i > 0; i--) {
            if (!block) {
                break;
            }
            locators.push(block.prevHash);
            block = await this.getBlock(block.prevHash); // eslint-disable-line no-await-in-loop
        }

        let step = 2;
        for (let i = this.height - 10 - step; i > 0; i -= step) {
            block = await this.getBlockAt(i); // eslint-disable-line no-await-in-loop
            if (block) {
                locators.push(await block.hash()); // eslint-disable-line no-await-in-loop
            }
            step *= 2;
        }

        // Push the genesis block hash.
        if (locators.length === 0 || !locators[locators.length - 1].equals(Block.GENESIS.HASH)) {
            locators.push(Block.GENESIS.HASH);
        }

        return locators;
    }


    /* NIPoPoW Prover functions */

    /**
     * @param {number} height
     * @returns {Promise.<ChainProof>}
     * @protected
     */
    async _getChainProof(height = this.height) {
        const snapshot = this._store.snapshot();
        const chain = new BaseChainSnapshot(snapshot, this.head);
        const proof = await chain._prove(Policy.M, Policy.K, Policy.DELTA, height);
        snapshot.abort();
        return proof;
    }

    /**
     * The "Prove" algorithm from the NIPoPow paper.
     * @param {number} m
     * @param {number} k
     * @param {number} delta
     * @param {number} [height]
     * @returns {Promise.<ChainProof>}
     * @private
     */
    async _prove(m, k, delta, height = this.height) {
        Assert.that(m >= 1, 'm must be >= 1');
        Assert.that(delta > 0, 'delta must be > 0');
        let prefix = new BlockChain([]);

        // B <- C[0]
        let startHeight = 1;

        const head = await this.getBlockAt(Math.max(height - k, 1)); // C[-k]
        const maxDepth = Math.max(BlockUtils.getTargetDepth(head.target) + head.interlink.length - 1, 0); // |C[-k].interlink|
        // for mu = |C[-k].interlink| down to 0 do
        for (let depth = maxDepth; depth >= 0; depth--) {
            // alpha = C[:-k]{B:}|^mu
            const alpha = await this._getSuperChain(depth, head, startHeight); // eslint-disable-line no-await-in-loop

            // pi = pi (union) alpha
            prefix = BlockChain.merge(prefix, alpha);

            // if good_(delta,m)(C, alpha, mu) then
            if (BaseChain._isGoodSuperChain(alpha, depth, m, delta)) {
                Assert.that(alpha.length >= m, `Good superchain expected to be at least ${m} long`);
                Log.v(BaseChain, `Found good superchain at depth ${depth} with length ${alpha.length} (#${startHeight} - #${head.height})`);
                // B <- alpha[-m]
                startHeight = alpha.blocks[alpha.length - m].height;
            }
        }

        // X <- C[-k:]
        const suffixHead = await this.getBlockAt(height);
        const suffix = await this._getHeaderChain(height - head.height, suffixHead);

        // return piX
        return new ChainProof(prefix, suffix);
    }

    /**
     * @param {number} depth
     * @param {Block} [head]
     * @param {number} [tailHeight]
     * @returns {Promise.<BlockChain>}
     * @private
     */
    async _getSuperChain(depth, head = this.head, tailHeight = 1) {
        Assert.that(tailHeight >= 1, 'tailHeight must be >= 1');
        const blocks = [];

        // Include head if it is at the requested depth or below.
        const headPow = await head.pow();
        const headDepth = BlockUtils.getTargetDepth(BlockUtils.hashToTarget(headPow));
        if (headDepth >= depth) {
            blocks.push(head.toLight());
        }

        // Follow the interlink pointers back at the requested depth.
        let j = Math.max(depth - BlockUtils.getTargetDepth(head.target), 0);
        while (j < head.interlink.hashes.length && head.height > tailHeight) {
            head = await this.getBlock(head.interlink.hashes[j]); // eslint-disable-line no-await-in-loop
            if (!head) {
                // This can happen in the light/nano client if chain superquality is harmed.
                // Return a best-effort chain in this case.
                Log.w(BaseChain, `Failed to find block ${head.interlink.hashes[j]} while constructing SuperChain at depth ${depth} - returning truncated chain`);
                break;
            }
            blocks.push(head.toLight());

            j = Math.max(depth - BlockUtils.getTargetDepth(head.target), 0);
        }

        if ((blocks.length === 0 || blocks[blocks.length - 1].height > 1) && tailHeight === 1) {
            blocks.push(Block.GENESIS.toLight());
        }

        return new BlockChain(blocks.reverse());
    }

    /**
     * @param {BlockChain} superchain
     * @param {number} depth
     * @param {number} m
     * @param {number} delta
     * @returns {boolean}
     */
    static _isGoodSuperChain(superchain, depth, m, delta) {
        // TODO multilevel quality
        return BaseChain._hasSuperQuality(superchain, depth, m, delta);
    }

    /**
     * @param {BlockChain} superchain
     * @param {number} depth
     * @param {number} m
     * @param {number} delta
     * @returns {boolean}
     * @private
     */
    static _hasSuperQuality(superchain, depth, m, delta) {
        Assert.that(m >= 1, 'm must be >= 1');
        if (superchain.length < m) {
            return false;
        }

        for (let i = m; i <= superchain.length; i++) {
            const underlyingLength = superchain.head.height - superchain.blocks[superchain.length - i].height + 1;
            if (!BaseChain._isLocallyGood(i, underlyingLength, depth, delta)) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param {number} superLength
     * @param {number} underlyingLength
     * @param {number} depth
     * @param {number} delta
     * @returns {boolean}
     * @private
     */
    static _isLocallyGood(superLength, underlyingLength, depth, delta) {
        // |C'| > (1 - delta) * 2^(-mu) * |C|
        return superLength > (1 - delta) * Math.pow(2, -depth) * underlyingLength;
    }

    /**
     * @param {number} length
     * @param {Block} [head]
     * @returns {Promise.<HeaderChain>}
     * @private
     */
    async _getHeaderChain(length, head = this.head) {
        const headers = [];
        while (head && headers.length < length) {
            headers.push(head.header);
            head = await this.getBlock(head.prevHash); // eslint-disable-line no-await-in-loop
        }
        return new HeaderChain(headers.reverse());
    }

    /**
     * @param {ChainProof} proof
     * @param {BlockHeader} header
     * @param {boolean} [failOnBadness]
     * @returns {Promise.<ChainProof>}
     * @protected
     */
    async _extendChainProof(proof, header, failOnBadness = true) {
        // Append new header to proof suffix.
        const suffix = proof.suffix.headers.slice();
        suffix.push(header);

        // If the suffix is not long enough (short chain), we're done.
        const prefix = proof.prefix.blocks.slice();
        if (suffix.length <= Policy.K) {
            return new ChainProof(new BlockChain(prefix), new HeaderChain(suffix));
        }

        // Cut the tail off the suffix.
        const suffixTail = suffix.shift();

        // Construct light block out of the old suffix tail.
        const interlink = await proof.prefix.head.getNextInterlink(suffixTail.target, suffixTail.version);
        const prefixHead = new Block(suffixTail, interlink);

        // Append old suffix tail block to prefix.
        prefix.push(prefixHead);

        // Extract layered superchains from prefix. Make a copy because we are going to change the chains array.
        const chains = (await proof.prefix.getSuperChains()).slice();

        // Append new prefix head to chains.
        const target = BlockUtils.hashToTarget(await prefixHead.pow());
        const depth = BlockUtils.getTargetDepth(target);
        for (let i = depth; i >= 0; i--) {
            // Append block. Don't modify the chain, create a copy.
            if (!chains[i]) {
                chains[i] = new BlockChain([prefixHead]);
            } else {
                chains[i] = new BlockChain([...chains[i].blocks, prefixHead]);
            }
        }

        // If the new header isn't a superblock, we're done.
        if (depth - BlockUtils.getTargetDepth(prefixHead.target) <= 0) {
            return new ChainProof(new BlockChain(prefix, chains), new HeaderChain(suffix));
        }

        // Prune unnecessary blocks if the chain is good.
        // Try to extend proof if the chain is bad.
        const newPrefix = await this._pruneOrExtendPrefix(prefix, chains, depth, failOnBadness);
        if (!newPrefix) {
            return null;
        }

        // Return the extended proof.
        return new ChainProof(newPrefix, new HeaderChain(suffix));
    }

    /**
     * @param {Array.<Block>} prefixBlocks
     * @param {Array.<BlockChain>} prefixChains
     * @param {number} [depth]
     * @param {boolean} [failOnBadness]
     * @returns {Promise.<?BlockChain>}
     * @private
     */
    async _pruneOrExtendPrefix(prefixBlocks, prefixChains, depth = -1, failOnBadness = true) {
        Assert.that(prefixBlocks.length > 0);
        if (depth < 0) {
            const tailBlock = prefixBlocks[prefixBlocks.length - 1];
            depth = Math.max(BlockUtils.getTargetDepth(tailBlock.target) + tailBlock.interlink.length - 1, 0);
        }

        const deletedBlockHeights = new Set();
        for (let i = depth; i >= 0; i--) {
            const superchain = prefixChains[i];
            if (superchain.length < Policy.M) {
                continue;
            }

            if (!BaseChain._isGoodSuperChain(superchain, i, Policy.M, Policy.DELTA)) {
                Log.w(BaseChain, `Chain quality badness detected at depth ${i}`);
                // TODO extend superchains at lower levels
                if (failOnBadness) {
                    return null;
                }
                continue;
            }

            // Remove all blocks in lower chains up to (including) superchain[-m].
            const referenceBlock = superchain.blocks[superchain.length - Policy.M];
            for (let j = i - 1; j >= 0; j--) {
                let numBlocksToDelete = 0;
                let candidateBlock = prefixChains[j].blocks[numBlocksToDelete];
                while (candidateBlock.height <= referenceBlock.height) {
                    const candidateTarget = BlockUtils.hashToTarget(await candidateBlock.pow());
                    const candidateDepth = BlockUtils.getTargetDepth(candidateTarget);
                    if (candidateDepth === j && candidateBlock.height > 1) {
                        deletedBlockHeights.add(candidateBlock.height);
                    }

                    numBlocksToDelete++;
                    candidateBlock = prefixChains[j].blocks[numBlocksToDelete];
                }

                if (numBlocksToDelete > 0) {
                    // Don't modify the chain, create a copy.
                    prefixChains[j] = new BlockChain(prefixChains[j].blocks.slice(numBlocksToDelete));
                }
            }
        }

        // Remove all deleted blocks from prefix.
        return new BlockChain(prefixBlocks.filter(block => !deletedBlockHeights.has(block.height)), prefixChains);
    }

    /**
     * @param {Block} blockToProve
     * @param {ChainProof} [proof]
     * @returns {Promise.<?ChainProof>}
     * @protected
     */
    async _getInfixProof(blockToProve, proof) {
        proof = proof || await this.getChainProof();
        const hashToProve = await blockToProve.hash();

        // Check whether the blockToProve is (potentially) part of the proof suffix.
        if (blockToProve.height > proof.prefix.head.height) {
            // Fail if blockToProve is beyond the end of the suffix.
            if (blockToProve.height > proof.suffix.head.height) {
                return null;
            }

            let i = 0;
            while (i < proof.suffix.length && proof.suffix.headers[i].height < blockToProve.height) i++;

            // Since the suffix is dense, the block at suffix[i] should be the blockToProve.
            // If it isn't, blockToProve is not part of the underlying chain.
            if (!hashToProve.equals(await proof.suffix.headers[i].hash())) {
                return null;
            }

            // Return a proof with a prefix consisting only of the blockToProve and the successors
            // of blockToProve in the suffix.
            const suffix = proof.suffix.headers.slice(i + 1);
            const prefix = [blockToProve.toLight()];
            return new ChainProof(new BlockChain(prefix), new HeaderChain(suffix));
        }

        // The block is (potentially) part of the prefix.
        // Remove all prefix blocks that precede the blockToProve.
        let i = 0;
        while (i < proof.prefix.length && proof.prefix.blocks[i].height < blockToProve.height) i++;
        let prefix = proof.prefix.blocks.slice(i);

        // If the block is contained in the prefix, simply return a proof with the truncated prefix.
        if (hashToProve.equals(await prefix[0].hash())) {
            return new ChainProof(new BlockChain(prefix), proof.suffix);
        }

        // The block is not contained in the prefix, connect it to the tail block of the prefix.
        // If this fails, blockToProve (or the given proof) is not on our main chain.
        const blocks = await this._followDown(blockToProve, prefix[0]);
        if (!blocks) {
            return null;
        }

        // Prepend the connecting blocks to the prefix and return the resulting proof.
        prefix = blocks.concat(prefix);
        return new ChainProof(new BlockChain(prefix), proof.suffix);
    }

    /**
     * @param {Block} blockToProve
     * @param {Block} tailBlock
     * @returns {Promise.<?Array.<Block>>}
     * @protected
     */
    async _followDown(blockToProve, tailBlock) {
        const blocks = [];
        const hashToProve = await blockToProve.hash();

        const getReferenceIndex = (references, depth, block) => {
            return Math.max(Math.min(depth - BlockUtils.getTargetDepth(block.target), references.length - 1), 0);
        };

        const tailTarget = BlockUtils.hashToTarget(await tailBlock.pow());
        const tailDepth = BlockUtils.getTargetDepth(tailTarget);

        const proveTarget = BlockUtils.hashToTarget(await blockToProve.pow());
        const proveDepth = BlockUtils.getTargetDepth(proveTarget);

        let depth = tailDepth;
        let block = tailBlock;

        let references = [block.prevHash, ...block.interlink.hashes.slice(1)];
        let refIndex = getReferenceIndex(references, depth, block);
        while (!hashToProve.equals(references[refIndex])) {
            const nextBlock = await this.getBlock(references[refIndex]); // eslint-disable-line no-await-in-loop
            if (!nextBlock) {
                // This can happen in the light/nano client if the blockToProve is known but blocks between tailBlock
                // and blockToProve are missing.
                Log.w(BaseChain, `Failed to find block ${references[refIndex]} while constructing infix proof`);
                return null;
            }

            if (nextBlock.height < blockToProve.height) {
                // We have gone past the blockToProve, but are already at proveDepth, fail.
                if (depth <= proveDepth) {
                    return null;
                }

                // Decrease depth and thereby step size.
                depth--;
                refIndex = getReferenceIndex(references, depth, block);
            } else if (nextBlock.height > blockToProve.height) {
                // We are still in front of blockToProve, add block to result and advance.
                blocks.push(nextBlock.toLight());

                block = nextBlock;
                references = [block.prevHash, ...block.interlink.hashes.slice(1)];
                refIndex = getReferenceIndex(references, depth, block);
            } else {
                // We found a reference to a different block than blockToProve at its height.
                Log.w(BaseChain, `Failed to prove block ${hashToProve} - different block ${references[refIndex]} at its height ${block.height}`);
                return null;
            }
        }

        // Include the blockToProve in the result.
        blocks.push(blockToProve.toLight());

        return blocks.reverse();
    }

    /**
     * @param {ChainProof} baseProof
     * @param {ChainProof} infixProof
     * @param {boolean} [failOnBadness]
     * @returns {Promise.<?ChainProof>}
     * @protected
     */
    async _joinChainProofs(baseProof, infixProof, failOnBadness = true) {
        const infixTail = infixProof.tail;
        const references = new HashSet();
        references.addAll([infixTail.prevHash, infixTail.interlink.hashes.slice(1)]);

        // Find the closest predecessor p of infixTail in baseProof.
        // Scan the suffix first.
        let index = -1;
        for (let i = 0; i < baseProof.suffix.length; i++) {
            const header = baseProof.suffix.headers[i];
            if (header.height >= infixTail.height) {
                break;
            }

            const hash = await header.hash();
            if (references.contains(hash)) {
                index = i;
            }
        }

        /** @type {BlockChain} */
        let prefix;

        // If index >= 0, we found a predecessor of infixTail in the suffix.
        if (index >= 0) {
            // Turn the suffix headers up to p into light blocks by computing their interlinks.
            // We assume that baseProof is verified and interlink hashes have been checked!
            const suffixBlocks = [];
            let head = baseProof.prefix.head;
            for (let j = 0; j <= index; j++) {
                const header = baseProof.suffix.headers[j];
                const interlink = await head.getNextInterlink(header.target, header.version);
                head = new Block(header, interlink);
                suffixBlocks.push(head);
            }

            // Append the suffix blocks to the baseProof prefix. Copy it first.
            prefix = baseProof.prefix.clone();
            for (const suffixBlock of suffixBlocks) {
                await prefix.append(suffixBlock);
            }
        }

        // Otherwise, we didn't find a predecessor in the suffix, scan the prefix.
        else {
            for (let i = 0; i < baseProof.prefix.length; i++) {
                const block = baseProof.prefix.blocks[i];
                if (block.height >= infixTail.height) {
                    break;
                }

                const hash = await block.hash();
                if (references.contains(hash)) {
                    index = i;
                }
            }

            // If the infixTail is not found, the proofs cannot be joined, fail.
            if (index < 0) {
                return null;
            }

            // Cut off all blocks after the predecessor from the baseProof prefix.
            prefix = baseProof.prefix.slice(0, index + 1);
        }

        // Append infixProof to new prefix. Also join superchains.
        for (const block of infixProof.prefix.blocks) {
            await prefix.append(block);
        }

        // Remove unnecessary blocks from proof.
        console.time('getSuperChains');
        const chains = await prefix.getSuperChains();
        console.timeEnd('getSuperChains');

        console.time('pruneOrExtend');
        const newPrefix = await this._pruneOrExtendPrefix(prefix.blocks, chains, /*depth*/ -1, failOnBadness);
        console.timeEnd('pruneOrExtend');

        if (!newPrefix) {
            return null;
        }

        // Return the joined proof.
        return new ChainProof(newPrefix, infixProof.suffix);
    }


    /* NiPoPoW Verifier functions */

    /**
     * @param {ChainProof} proof1
     * @param {ChainProof} proof2
     * @param {number} m
     * @returns {boolean}
     */
    static async isBetterProof(proof1, proof2, m) {
        const lca = BlockChain.lowestCommonAncestor(proof1.prefix, proof2.prefix);
        const score1 = await NanoChain._getProofScore(proof1.prefix, lca, m);
        const score2 = await NanoChain._getProofScore(proof2.prefix, lca, m);
        return score1 === score2
            ? proof1.suffix.totalDifficulty() >= proof2.suffix.totalDifficulty()
            : score1 > score2;
    }

    /**
     *
     * @param {BlockChain} chain
     * @param {Block} lca
     * @param {number} m
     * @returns {Promise.<number>}
     * @protected
     */
    static async _getProofScore(chain, lca, m) {
        const counts = [];
        for (const block of chain.blocks) {
            if (block.height < lca.height) {
                continue;
            }

            const target = BlockUtils.hashToTarget(await block.pow()); // eslint-disable-line no-await-in-loop
            const depth = BlockUtils.getTargetDepth(target);
            counts[depth] = counts[depth] ? counts[depth] + 1 : 1;
        }

        let sum = 0;
        let depth;
        for (depth = counts.length - 1; sum < m && depth >= 0; depth--) {
            sum += counts[depth] ? counts[depth] : 0;
        }

        let maxScore = Math.pow(2, depth + 1) * sum;
        let length = sum;
        for (let i = depth; i >= 0; i--) {
            length += counts[i] ? counts[i] : 0;
            const score = Math.pow(2, i) * length;
            maxScore = Math.max(maxScore, score);
        }

        return maxScore;
    }
}
Class.register(BaseChain);

class BaseChainSnapshot extends BaseChain {
    /**
     * @param {ChainDataStore} store
     * @param {Block} head
     */
    constructor(store, head) {
        super(store);
        this._head = head;
    }

    /** @type {Block} */
    get head() {
        return this._head;
    }

    /** @type {number} */
    get height() {
        return this._head.height;
    }
}
Class.register(BaseChainSnapshot);
