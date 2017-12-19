class GetChainProofMessage extends Message {
    /**
     * @param {Array.<Hash>} locators
     */
    constructor(locators) {
        super(Message.Type.GET_CHAIN_PROOF);
        if (locators && (!Array.isArray(locators) || !NumberUtils.isUint8(locators.length)
            || locators.some(it => !Hash.isHash(it)))) throw new Error('Malformed locators');

        /**
         * @type {Array.<Hash>}
         * @private
         */
        this._locators = locators;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetChainProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        // XXX Detect if there are block locators in the message.
        // FIXME Remove check after next hardfork
        let locators = null;
        if (buf.readPos < buf.byteLength) {
            const count = buf.readUint8();
            locators = [];
            for (let i = 0; i < count; i++) {
                locators.push(Hash.unserialize(buf));
            }
        }
        return new GetChainProofMessage(locators);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        // XXX Detect if there are block locators in the message.
        // FIXME Remove check after next hardfork
        if (this._locators) {
            buf.writeUint8(this._locators.length);
            for (const locator of this._locators) {
                locator.serialize(buf);
            }
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize;
    }

    /** @type {?Array.<Hash>} */
    get locators() {
        return this._locators;
    }
}
Class.register(GetChainProofMessage);
