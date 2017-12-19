/**
 * @implements {ICodec}
 */
class ChainDataStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return ChainDataStoreCodec.serialize(obj);
    }

    /**
     * @param {*} obj The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(obj, key) {
        return ChainDataStoreCodec.unserialize(new SerialBuffer(obj));
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {ChainData|string}
     */
    static unserialize(buf) {
        const isChainData = buf.readUint8();
        if (isChainData === 1) {
            return ChainData.unserialize(buf);
        } else {
            return buf.readVarLengthString();
        }
    }

    /**
     * @param {ChainData|string} obj
     * @returns {SerialBuffer}
     */
    static serialize(obj) {
        const buf = new SerialBuffer(ChainDataStoreCodec.serializedSize(obj));
        const isChainData = obj instanceof ChainData;
        buf.writeUint8(isChainData ? 1 : 0);
        if (isChainData) {
            obj.serialize(buf);
        } else {
            buf.writeVarLengthString(obj);
        }
        return buf;
    }

    /**
     * @param {ChainData|string} obj
     * @returns {number}
     */
    static serializedSize(obj) {
        if (obj instanceof ChainData) {
            return /*isChainData*/ 1 + obj.serializedSize;
        } else {
            return /*isChainData*/ 1 + /*length*/ 1 + obj.length;
        }
    }

    /**
     * @type {{encode: function(val:*):*, decode: function(val:*):*, buffer: boolean, type: string}|void}
     */
    get valueEncoding() {
        return 'binary';
    }
}
Class.register(ChainDataStoreCodec);
