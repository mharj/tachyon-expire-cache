import {type IAsyncCache, type IAsyncCacheOnClearCallback} from '@avanio/expire-cache';
import {type ILoggerLike, LogLevel, type LogMapping, MapLogger} from '@avanio/logger-like';
import {type IStorageDriver} from 'tachyon-drive';

/**
 * IterableIterator to AsyncIterableIterator
 * @param callIterable get the iterable iterator
 * @param initialize callback to initialize storage driver (before get the iterable)
 * @returns AsyncIterableIterator
 */
function toAsyncIterableIterator<T>(callIterable: () => IterableIterator<T>, initialize: () => Promise<void>): AsyncIterableIterator<T> {
	return (async function* () {
		await initialize(); // ensure the storage driver is hydrated
		for (const value of callIterable()) {
			yield value;
		}
	})();
}

/**
 * Default log map for ExpireCache method calls (no logs)
 */
const defaultLogMap = {
	cleanExpired: LogLevel.None,
	clear: LogLevel.None,
	constructor: LogLevel.None,
	delete: LogLevel.None,
	entries: LogLevel.None,
	expires: LogLevel.None,
	get: LogLevel.None,
	has: LogLevel.None,
	hydrate: LogLevel.None,
	keys: LogLevel.None,
	rebuild: LogLevel.None,
	set: LogLevel.None,
	size: LogLevel.None,
	store: LogLevel.None,
	values: LogLevel.None,
} satisfies LogMapping;

export type ExpireCacheLogMapType = LogMapping<keyof typeof defaultLogMap>;

export type CachePayload<Payload> = {data: Payload; expires: number | undefined};

export type CacheMap<Payload, Key = string> = Map<Key, CachePayload<Payload>>;

/**
 * TachyonExpireCache implements IAsyncCache using a Tachyon storage driver to persist the cache.
 *
 * Data is stored as a ```CacheMap<Payload, Key = string>``` if building validation for serialization.
 */
export class TachyonExpireCache<Payload, Key = string> extends MapLogger<ExpireCacheLogMapType> implements IAsyncCache<Payload, Key> {
	public readonly name: string;
	private cache = new Map<Key, CachePayload<Payload>>();
	private defaultExpireMs: undefined | number;
	private driver: IStorageDriver<CacheMap<Payload, Key>>;
	private isHydrated = false;
	private isWriting = false;
	private hydratePromise: Promise<CacheMap<Payload, Key> | undefined> | CacheMap<Payload, Key> | undefined;
	private onClearCallbacks = new Set<IAsyncCacheOnClearCallback<Payload, Key>>();

	constructor(
		name: string,
		driver: IStorageDriver<CacheMap<Payload, Key>>,
		logger?: ILoggerLike,
		logMapping?: ExpireCacheLogMapType,
		defaultExpireMs?: number,
	) {
		super(logger, Object.assign({}, defaultLogMap, logMapping));
		this.name = name;
		this.driver = driver;
		this.defaultExpireMs = defaultExpireMs;
		this.driver.on('update', (data) => {
			if (!this.isWriting && data) {
				this.handleRebuild(data, 'update');
			}
		});
		this.doInitialHydrate = this.doInitialHydrate.bind(this);
	}

	public onClear(callback: IAsyncCacheOnClearCallback<Payload, Key>): void {
		this.onClearCallbacks.add(callback);
	}

	/**
	 * Get an AsyncIterableIterator of Cache entries
	 * @returns AsyncIterableIterator<[Key, Payload]>
	 * @example
	 * for await (const [key, value] of cache.entries()) {}
	 */
	public entries(): AsyncIterableIterator<[Key, Payload]> {
		this.logMessage('entries', 'entries');
		return toAsyncIterableIterator(() => this.buildFlatDataMap().entries(), this.doInitialHydrate);
	}

	/**
	 * Get an AsyncIterableIterator of Cache keys
	 * @returns AsyncIterableIterator<Key>
	 * @example
	 * for await (const key of cache.keys()) {}
	 */
	public keys(): AsyncIterableIterator<Key> {
		this.logMessage('keys', 'keys');
		return toAsyncIterableIterator(() => this.cache.keys(), this.doInitialHydrate);
	}

	/**
	 * Get an AsyncIterableIterator of Cache values
	 * @returns AsyncIterableIterator<Payload>
	 * @example
	 * for await (const value of cache.values()) {}
	 */
	public values(): AsyncIterableIterator<Payload> {
		this.logMessage('values', 'values');
		return toAsyncIterableIterator(() => this.buildFlatDataMap().values(), this.doInitialHydrate);
	}

	public async get(key: Key): Promise<Payload | undefined> {
		await this.doInitialHydrate();
		this.logMessage('get', `get with key: '${key}'`);
		await this.cleanExpired();
		return this.cache.get(key)?.data;
	}

	public async set(key: Key, data: Payload, expires?: Date | undefined): Promise<void> {
		await this.doInitialHydrate();
		const expireTs: number | undefined = expires?.getTime() ?? (this.defaultExpireMs && Date.now() + this.defaultExpireMs);
		this.logMessage('set', `set key: '${key}', expireTs: ${expireTs}`);
		this.cache.set(key, {data, expires: expireTs});
		await this.handleStore();
	}

	public async delete(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logMessage('delete', `delete key: '${key}'`);
		const value = this.cache.get(key);
		if (value) {
			const isDeleted = this.cache.delete(key);
			if (isDeleted) {
				await this.handleStore();
				await this.notifyClear(new Map<Key, Payload>([[key, value.data]]));
			}
			return isDeleted;
		}
		return false;
	}

	public async has(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logMessage('has', `has key: '${key}'`);
		this.cleanExpired();
		return this.cache.has(key);
	}

	public async expires(key: Key): Promise<Date | undefined> {
		await this.doInitialHydrate();
		this.logMessage('expires', `get expire key: '${key}'`);
		this.cleanExpired();
		const entry = this.cache.get(key);
		return entry?.expires ? new Date(entry.expires) : undefined;
	}

	public async clear(): Promise<void> {
		await this.doInitialHydrate();
		this.logMessage('clear', `clear`);
		const deleteData = this.buildFlatDataMap();
		this.cache.clear();
		await this.notifyClear(deleteData);
		return this.handleStore();
	}

	public async size(): Promise<number> {
		await this.doInitialHydrate();
		this.logMessage('size', `size: ${this.cache.size}`);
		return this.cache.size;
	}

	private buildFlatDataMap(): Map<Key, Payload> {
		return new Map(Array.from(this.cache.entries()).map(([key, value]) => [key, value.data]));
	}

	private async doInitialHydrate(): Promise<void> {
		if (!this.isHydrated) {
			// only hydrate data once
			if (!this.hydratePromise) {
				this.logMessage('hydrate', 'hydrate');
				this.hydratePromise = this.driver.hydrate();
			}
			const data = await this.hydratePromise;
			if (data) {
				this.handleRebuild(data, 'initial');
			}
			this.isHydrated = true;
			this.hydratePromise = undefined;
		}
	}

	private handleRebuild(data: CacheMap<Payload, Key>, type: 'initial' | 'update') {
		this.logMessage('rebuild', `${type} rebuild Cache Map`);
		this.cache = data;
	}

	private async handleStore(): Promise<void> {
		this.logMessage('store', 'store');
		this.isWriting = true; // lock updates from driver as we are writing
		await this.driver.store(this.cache);
		// release the write lock after 100ms
		setTimeout(() => {
			this.isWriting = false;
		}, 100);
	}

	private async cleanExpired(): Promise<void> {
		const deleteData = new Map<Key, Payload>();
		const now = new Date().getTime();
		for (const [key, value] of this.cache.entries()) {
			if (value.expires !== undefined && value.expires < now) {
				deleteData.set(key, value.data);
				this.cache.delete(key);
			}
		}
		if (deleteData.size > 0) {
			this.logMessage('cleanExpired', `expired count: ${deleteData.size}`);
			await this.handleStore();
			await this.notifyClear(deleteData);
		}
	}

	private async notifyClear(deleteData: Map<Key, Payload>): Promise<void> {
		await Promise.all(Array.from(this.onClearCallbacks).map((callback) => callback(deleteData)));
	}

	private logMessage(key: keyof ExpireCacheLogMapType, message: string): void {
		this.logKey(key, `TachyonExpireCache[${this.name}]: ${message}`);
	}
}
