import {
  BigNumber,
  Contract,
  providers,
  Transaction,
  Wallet,
} from 'ethers';
import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { rootPath } from '../../paths';
import { TokenListType, TokenValue, walletPath } from '../../services/base';
import { EVMNonceManager } from '../../chains/ethereum/evm.nonce';  // Corrected path
import NodeCache from 'node-cache';
import { EvmTxStorage } from '../../chains/ethereum/evm.tx-storage';  // Corrected path
import fse from 'fs-extra';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { logger } from '../../services/logger';
import { ReferenceCountingCloseable } from '../../services/refcounting-closeable';
import { getAddress } from 'ethers/lib/utils';

// Information about an Ethereum token
export interface TokenInfo {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export type NewBlockHandler = (bn: number) => void;

export type NewDebugMsgHandler = (msg: any) => void;

class EthereumBase {
  private provider: providers.StaticJsonRpcProvider;
  private tokenList: TokenInfo[] = [];
  private _tokenMap: Record<string, TokenInfo> = {};
  private _ready: boolean = false;
  private _initialized: Promise<boolean> = Promise.resolve(false);
  public chainName: string;
  public chainId: number;
  public rpcUrl: string;
  public gasPriceConstant: number;
  private _gasLimitTransaction: number;
  public tokenListSource: string;
  public tokenListType: TokenListType;
  public cache: NodeCache;
  private readonly _refCountingHandle: string;
  private readonly _nonceManager: EVMNonceManager;
  private readonly _txStorage: EvmTxStorage;

  constructor(
    chainName: string,
    chainId: number,
    rpcUrl: string,
    tokenListSource: string,
    tokenListType: TokenListType,
    gasPriceConstant: number,
    gasLimitTransaction: number,
    nonceDbPath: string,
    transactionDbPath: string,
  ) {
    this.chainName = chainName;
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;
    this.gasPriceConstant = gasPriceConstant;
    this.tokenListSource = tokenListSource;
    this.tokenListType = tokenListType;

    this.provider = new providers.StaticJsonRpcProvider(rpcUrl);
    this._refCountingHandle = ReferenceCountingCloseable.createHandle();
    this._nonceManager = new EVMNonceManager(
      chainName,
      chainId,
      this.resolveDBPath(nonceDbPath),
    );
    this._nonceManager.declareOwnership(this._refCountingHandle);
    this.cache = new NodeCache({ stdTTL: 3600 });
    this._gasLimitTransaction = gasLimitTransaction;
    this._txStorage = EvmTxStorage.getInstance(
      this.resolveDBPath(transactionDbPath),
      this._refCountingHandle,
    );
    this._txStorage.declareOwnership(this._refCountingHandle);
  }

  ready(): boolean {
    return this._ready;
  }

  public get gasLimitTransaction(): number {
    return this._gasLimitTransaction;
  }

  public resolveDBPath(oldPath: string): string {
    if (oldPath.charAt(0) === '/') return oldPath;
    const dbDir: string = path.join(rootPath(), 'db/');
    fse.mkdirSync(dbDir, { recursive: true });
    return path.join(dbDir, oldPath);
  }

  public events() {
    return this.provider._events.map(function (event: any) {
      return [event.tag];
    });
  }

  public onNewBlock(func: NewBlockHandler) {
    this.provider.on('block', func);
  }

  public onDebugMessage(func: NewDebugMsgHandler) {
    this.provider.on('debug', func);
  }

  async init(): Promise<void> {
    await this._initialized;
    if (!this.ready()) {
      this._initialized = (async () => {
        try {
          await this._nonceManager.init(
            async (address: string) => await this.provider.getTransactionCount(address),
            async (nextNonce: number) => nextNonce,
          );
          await this.loadTokens(this.tokenListSource, this.tokenListType);
          return true;
        } catch (e) {
          logger.error(`Failed to initialize ${this.chainName} chain: ${e}`);
          return false;
        }
      })();
      this._ready = await this._initialized;
    }
  }

  async loadTokens(
    tokenListSource: string,
    tokenListType: TokenListType,
  ): Promise<void> {
    this.tokenList = await this.getTokenList(tokenListSource, tokenListType);
    this.tokenList = this.tokenList.filter(
      (token: TokenInfo) => token.chainId === this.chainId,
    );
    if (this.tokenList) {
      this.tokenList.forEach(
        (token: TokenInfo) => (this._tokenMap[token.symbol] = token),
      );
    }
  }

  async getTokenList(
    tokenListSource: string,
    tokenListType: TokenListType,
  ): Promise<TokenInfo[]> {
    let tokens: TokenInfo[];
    if (tokenListType === 'URL') {
      ({
        data: { tokens },
      } = await axios.get(tokenListSource));
    } else {
      ({ tokens } = JSON.parse(await fs.readFile(tokenListSource, 'utf8')));
    }
    const mappedTokens: TokenInfo[] = tokens.map((token) => {
      token.address = getAddress(token.address);
      return token;
    });
    return mappedTokens;
  }

  public get nonceManager() {
    return this._nonceManager;
  }

  public get txStorage(): EvmTxStorage {
    return this._txStorage;
  }

  public get storedTokenList(): TokenInfo[] {
    return Object.values(this._tokenMap);
  }

  getTokenForSymbol(symbol: string): TokenInfo | null {
    return this._tokenMap[symbol] ? this._tokenMap[symbol] : null;
  }

  getWalletFromPrivateKey(privateKey: string): Wallet {
    return new Wallet(privateKey, this.provider);
  }

  async getWallet(address: string): Promise<Wallet> {
    const path = `${walletPath}/${this.chainName}`;

    const encryptedPrivateKey: string = await fse.readFile(
      `${path}/${address}.json`,
      'utf8',
    );

    const passphrase = ConfigManagerCertPassphrase.readPassphrase();
    if (!passphrase) {
      throw new Error('missing passphrase');
    }
    return await this.decrypt(encryptedPrivateKey, passphrase);
  }

  encrypt(privateKey: string, password: string): Promise<string> {
    const wallet = this.getWalletFromPrivateKey(privateKey);
    return wallet.encrypt(password);
  }

  async decrypt(
    encryptedPrivateKey: string,
    password: string,
  ): Promise<Wallet> {
    const wallet = await Wallet.fromEncryptedJson(
      encryptedPrivateKey,
      password,
    );
    return wallet.connect(this.provider);
  }

  async getNativeBalance(wallet: Wallet): Promise<TokenValue> {
    const balance = await wallet.getBalance();
    return { value: balance, decimals: 18 };
  }

  async getERC20Balance(
    contract: Contract,
    wallet: Wallet,
    decimals: number,
  ): Promise<TokenValue> {
    logger.info('Requesting balance for owner ' + wallet.address + '.');
    const balance: BigNumber = await contract.balanceOf(wallet.address);
    logger.info(
      `Raw balance of ${contract.address} for ` +
        `${wallet.address}: ${balance.toString()}`,
    );
    return { value: balance, decimals: decimals };
  }

  async getERC20Allowance(
  contract: Contract,
  wallet: Wallet,
  spender: string,
  decimals: number,
): Promise<TokenValue> {
  logger.info(
    'Requesting spender ' +
      spender +
      ' allowance for owner ' +
      wallet.address +
      '.',
  );
  const allowance = await contract.allowance(wallet.address, spender);
  logger.info(allowance);
  return { value: allowance, decimals: decimals };
}

async getTransaction(txHash: string): Promise<providers.TransactionResponse> {
  return this.provider.getTransaction(txHash);
}

cacheTransactionReceipt(tx: providers.TransactionReceipt) {
  this.cache.set(tx.transactionHash, tx);
}

async getTransactionReceipt(
  txHash: string,
): Promise<providers.TransactionReceipt | null> {
  if (this.cache.keys().includes(txHash)) {
    return this.cache.get(txHash) as providers.TransactionReceipt;
  } else {
    const fetchedTxReceipt =
      await this.provider.getTransactionReceipt(txHash);

    this.cache.set(txHash, fetchedTxReceipt);

    if (!fetchedTxReceipt) {
      this.provider.once(txHash, this.cacheTransactionReceipt.bind(this));
    }

    return fetchedTxReceipt;
  }
}

  async approveERC20(
    contract: Contract,
    wallet: Wallet,
    spender: string,
    amount: BigNumber,
    nonce?: number,
    maxFeePerGas?: BigNumber,
    maxPriorityFeePerGas?: BigNumber,
    gasPrice?: number,
  ): Promise<Transaction> {
    logger.info(
      'Calling approve method called for spender ' +
        spender +
        ' requesting allowance ' +
        amount.toString() +
        ' from owner ' +
        wallet.address +
        '.'
    );
    return this.nonceManager.provideNonce(
      nonce,
      wallet.address,
      async (nextNonce: number) => {
        const params: any = {
          gasLimit: this._gasLimitTransaction,
          nonce: nextNonce,
        };
        if (maxFeePerGas || maxPriorityFeePerGas) {
          params.maxFeePerGas = maxFeePerGas;
          params.maxPriorityFeePerGas = maxPriorityFeePerGas;
        } else if (gasPrice) {
          params.gasPrice = (gasPrice * 1e9).toFixed(0);
        }
        return contract.approve(spender, amount, params);
      }
    );
  }

  async getGasPrice(): Promise<number | null> {
    if (!this.ready) {
      await this.init();
    }
    const feeData: providers.FeeData = await this.provider.getFeeData();
    if (feeData.gasPrice !== null && feeData.maxPriorityFeePerGas !== null) {
      return (
        feeData.gasPrice.add(feeData.maxPriorityFeePerGas).toNumber() * 1e-9
      );
    } else {
      return null;
    }
  }

  async close() {
    await this._nonceManager.close(this._refCountingHandle);
    await this._txStorage.close(this._refCountingHandle);
  }
}

export default EthereumBase;
