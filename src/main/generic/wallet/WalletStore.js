// TODO: Move outside of Nimiq Core library?
class WalletStore {
    /**
     * @returns {Promise.<WalletStore>}
     */
    constructor() {
        this._jdb = new JDB.JungleDB('wallet', WalletStore.VERSION);
        /** @type {ObjectStore} */
        this._walletStore = null;
        /** @type {ObjectStore} */
        this._multisigStore = null;

        return this._init();
    }

    /**
     * @returns {Promise.<WalletStore>}
     */
    async _init() {
        // Initialize object stores.
        this._walletStore = this._jdb.createObjectStore(WalletStore.WALLET_DATABASE, new WalletStoreCodec());
        this._multisigStore = this._jdb.createObjectStore(WalletStore.MULTISIG_WALLET_DATABASE, new WalletStoreCodec());

        // Establish connection to database.
        await this._jdb.connect();

        return this;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async hasDefault(key) {
        const defaultAddress = await this._walletStore.get('default');
        return !!defaultAddress;
    }

    /**
     * @param {Uint8Array|string} [key]
     * @returns {Promise.<?Wallet>}
     */
    async getDefault(key) {
        const defaultAddress = await this._walletStore.get('default');
        if (!defaultAddress) {
            const defaultWallet = await Wallet.generate();
            await this.put(defaultWallet);
            await this.setDefault(defaultWallet.address);
            return defaultWallet;
        }
        const base64Address = new Address(defaultAddress);
        return this.get(base64Address, key);
    }

    /**
     * @param {Address} address
     * @returns {Promise}
     */
    setDefault(address) {
        const defaultAddress = address.serialize();
        return this._walletStore.put('default', defaultAddress);
    }

    /**
     * @param {Address} address
     * @param {Uint8Array|string} [key]
     * @returns {Promise.<Wallet>}
     */
    async get(address, key) {
        const base64Address = address.toBase64();
        const buf = await this._walletStore.get(base64Address);
        if (key) {
            return Wallet.loadEncrypted(buf, key);
        }
        return Wallet.loadPlain(buf);
    }

    /**
     * @param {Wallet} wallet
     * @param {Uint8Array|string} [key]
     * @param {Uint8Array|string} [unlockKey]
     * @returns {Promise}
     */
    put(wallet, key, unlockKey) {
        const base64Address = wallet.address.toBase64();
        let buf = null;
        if (key) {
            buf = wallet.exportEncrypted(key, unlockKey);
        } else {
            buf = wallet.exportPlain();
        }
        return this._walletStore.put(base64Address, buf);
    }

    /**
     * @returns {Promise<Array.<Address>>}
     */
    async list() {
        const keys = await this._walletStore.keys();
        return Array.from(keys).filter(key => key !== 'default').map(key => Address.fromBase64(key));
    }

    /**
     * @param {Address} address
     * @param {Uint8Array|string} [key]
     * @returns {Promise.<MultiSigWallet>}
     */
    async getMultiSig(address, key) {
        const base64Address = address.toBase64();
        const buf = await this._multisigStore.get(base64Address);
        if (key) {
            return MultiSigWallet.loadEncrypted(buf, key);
        }
        return MultiSigWallet.loadPlain(buf);
    }

    /**
     * @param {MultiSigWallet} wallet
     * @param {Uint8Array|string} [key]
     * @param {Uint8Array|string} [unlockKey]
     * @returns {Promise}
     */
    putMultiSig(wallet, key, unlockKey) {
        const base64Address = wallet.address.toBase64();
        let buf = null;
        if (key) {
            buf = wallet.exportEncrypted(key, unlockKey);
        } else {
            buf = wallet.exportPlain();
        }
        return this._multisigStore.put(base64Address, buf);
    }

    /**
     * @returns {Promise<Array.<Address>>}
     */
    async listMultiSig() {
        const keys = await this._multisigStore.keys();
        return Array.from(keys).map(key => Address.fromBase64(key));
    }

    close() {
        return this._jdb.close();
    }
}
Class.register(WalletStore);
WalletStore._instance = null;
WalletStore.VERSION = 1;
WalletStore.WALLET_DATABASE = 'wallets';
WalletStore.MULTISIG_WALLET_DATABASE = 'multisig-wallets';

/**
 * @implements {ICodec}
 */
class WalletStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return obj;
    }

    /**
     * @param {*} buf The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(buf, key) {
        return new Uint8Array(buf);
    }

    /**
     * @type {string}
     */
    get valueEncoding() {
        return 'binary';
    }
}
