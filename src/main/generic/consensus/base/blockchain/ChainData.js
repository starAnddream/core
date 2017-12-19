class ChainData {
    /**
     * @param {ChainData} o
     * @returns {ChainData}
     */
    static copy(o) {
        if (!o) return o;
        const head = Block.unserialize(new SerialBuffer(o._head));
        head.header._pow = Hash.unserialize(new SerialBuffer(o._pow));
        return new ChainData(
            head,
            o._totalDifficulty,
            o._totalWork,
            o._onMainChain
        );
    }

    /**
     * @param {Block} head
     * @param {number} totalDifficulty
     * @param {number} totalWork
     * @param {boolean} onMainChain
     */
    constructor(head, totalDifficulty, totalWork, onMainChain = false) {
        this._head = head;
        this._totalDifficulty = totalDifficulty;
        this._totalWork = totalWork;
        this._onMainChain = onMainChain;
        this._height = head.height;
    }

    stripDown() {
        Assert.that(this._head.header._pow instanceof Hash, 'Expected cashed PoW hash');
        return {
            _head: this._head.serialize(),
            _totalDifficulty: this._totalDifficulty,
            _totalWork: this._totalWork,
            _onMainChain: this._onMainChain,
            _height: this._height,
            _pow: this._head.header._pow.serialize()
        };
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {ChainData}
     */
    static unserialize(buf) {
        const head = Block.unserialize(buf);
        const totalDifficulty = buf.readFloat64();
        const totalWork = buf.readFloat64();
        const onMainChain = buf.readUint8();
        return new ChainData(head, totalDifficulty, totalWork, onMainChain !== 0);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._head.serialize(buf);
        buf.writeFloat64(this._totalDifficulty);
        buf.writeFloat64(this._totalWork);
        buf.writeUint8(this._onMainChain ? 1 : 0);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return this._head.serializedSize
            + /*totalDifficulty*/ 8
            + /*totalWork*/ 8
            + /*onMainChain*/ 1;
    }

    /** @type {Block} */
    get head() {
        return this._head;
    }

    /** @type {number} */
    get totalDifficulty() {
        return this._totalDifficulty;
    }

    /** @type {number} */
    get totalWork() {
        return this._totalWork;
    }

    /** @type {boolean} */
    get onMainChain() {
        return this._onMainChain;
    }

    /** @type {boolean} */
    set onMainChain(onMainChain) {
        this._onMainChain = onMainChain;
    }
}
Class.register(ChainData);
