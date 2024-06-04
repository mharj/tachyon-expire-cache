import {type IAsyncCache, type IAsyncCacheOnClearCallback} from '@avanio/expire-cache';
import {type ILoggerLike, LogLevel, type LogMapping, MapLogger} from '@avanio/logger-like';
import {type IStorageDriver, TachyonBandwidth} from 'tachyon-drive';
import {toError} from '@luolapeikko/ts-common';

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
	close: LogLevel.None,
	constructor: LogLevel.None,
	delete: LogLevel.None,
	entries: LogLevel.None,
	expires: LogLevel.None,
	get: LogLevel.None,
	has: LogLevel.None,
	hydrate: LogLevel.None,
	init: LogLevel.None,
	keys: LogLevel.None,
	rebuild: LogLevel.None,
	set: LogLevel.None,
	size: LogLevel.None,
	store: LogLevel.None,
	update: LogLevel.None,
	values: LogLevel.None,
} satisfies LogMapping;

export type ExpireCacheLogMapType = LogMapping<keyof typeof defaultLogMap>;

export type CachePayload<Payload> = {data: Payload; expires: number | undefined};

export type CacheMap<Payload, Key = string> = Map<Key, CachePayload<Payload>>;

export type TachyonExpireCacheOptions = {
	logger?: ILoggerLike;
	logMapping?: ExpireCacheLogMapType;
	defaultExpireMs?: number;
};

/**
 * TachyonExpireCache implements IAsyncCache using a Tachyon storage driver to persist the cache.
 *
 * Data is stored as a ```CacheMap<Payload, Key = string>``` if building validation for serialization.
 */
export class TachyonExpireCache<Payload, Key extends string = string> extends MapLogger<ExpireCacheLogMapType> implements IAsyncCache<Payload, Key> {
	public readonly name: string;
	private cache = new Map<Key, CachePayload<Payload>>();
	private defaultExpireMs: undefined | number;
	private driver: IStorageDriver<CacheMap<Payload, Key>>;
	private isHydrated = false;
	private isWriting = false;
	private hydratePromise: Promise<CacheMap<Payload, Key> | undefined> | CacheMap<Payload, Key> | undefined;
	private onClearCallbacks: (IAsyncCacheOnClearCallback<Payload, Key> | undefined)[] = [];

	constructor(name: string, driver: IStorageDriver<CacheMap<Payload, Key>>, {logger, logMapping, defaultExpireMs}: TachyonExpireCacheOptions = {}) {
		super(logger, Object.assign({}, defaultLogMap, logMapping));
		this.name = name;
		this.driver = driver;
		this.defaultExpireMs = defaultExpireMs;
		this.driver.on('update', async (data) => {
			if (!this.isWriting && data) {
				try {
					await this.handleUpdate(data);
				} catch (error) {
					this.logMessage('update', `update error: ${toError(error).message}`);
				}
			}
		});
		this.doInitialHydrate = this.doInitialHydrate.bind(this);
	}

	/**
	 * Add a callback to be called when the cache is cleared
	 * @param callback - the callback to call when the cache is cleared
	 * @returns number - callback index to use for offClear(index)
	 */
	public onClear(callback: IAsyncCacheOnClearCallback<Payload, Key>): number {
		const index = this.onClearCallbacks.length;
		this.onClearCallbacks.push(callback);
		return index;
	}

	/**
	 * Remove a callback that was added with onClear
	 * @param index - the index of the callback to remove
	 */
	public offClear(index: number): void {
		this.onClearCallbacks[index] = undefined;
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

	/**
	 * Get a value from the cache
	 * - cleanExpires: TachyonBandwidth.Small (small or higher driver bandwidth)
	 * @param key - the Cache key to get
	 * @returns Promise<Payload | undefined> - resolves with the value of the key or undefined if the key does not exist
	 */
	public async get(key: Key): Promise<Payload | undefined> {
		await this.doInitialHydrate();
		this.logMessage('get', `get with key: '${key}'`);
		await this.cleanExpired(TachyonBandwidth.Small);
		return this.cache.get(key)?.data;
	}

	/**
	 * Set a key in the cache
	 * - stores: TachyonBandwidth.VerySmall (any driver bandwidth)
	 * @param key - the Cache key to set
	 * @param data - the data to set for the key
	 * @param expires - the expiration date of the key (optional)
	 * @returns Promise<void> - resolves when the key is set
	 */
	public async set(key: Key, data: Payload, expires?: Date | undefined): Promise<void> {
		await this.doInitialHydrate();
		const expireTs: number | undefined = expires?.getTime() ?? (this.defaultExpireMs && Date.now() + this.defaultExpireMs);
		this.logMessage('set', `set key: '${key}', expireTs: ${expireTs?.toString() ?? 'undefined'}`);
		this.cache.set(key, {data, expires: expireTs});
		await this.handleStore(TachyonBandwidth.VerySmall);
	}

	/**
	 * Delete a key from the cache
	 * - stores: TachyonBandwidth.VerySmall (any driver bandwidth)
	 * @param key - the Cache key to delete
	 * @returns Promise<boolean> - resolves with true if the key was deleted
	 */
	public async delete(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logMessage('delete', `delete key: '${key}'`);
		const value = this.cache.get(key);
		if (value) {
			const isDeleted = this.cache.delete(key);
			if (isDeleted) {
				await this.handleStore(TachyonBandwidth.VerySmall);
				await this.notifyClear(new Map<Key, Payload>([[key, value.data]]));
			}
			return isDeleted;
		}
		return false;
	}

	/**
	 * Check if a key exists in the cache
	 * - cleanExpires: TachyonBandwidth.Normal (normal or higher driver bandwidth)
	 * @param key - the Cache key to check for
	 * @returns Promise<boolean> - resolves with true if the key exists in the cache
	 */
	public async has(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logMessage('has', `has key: '${key}'`);
		await this.cleanExpired(TachyonBandwidth.Normal);
		return this.cache.has(key);
	}

	/**
	 * Get the expiration date of a key
	 * - cleanExpires: TachyonBandwidth.Normal (normal or higher driver bandwidth)
	 * @param key - the Cache key to get the expiration date for
	 * @returns Promise<Date | undefined> - resolves with the expiration date of the key or undefined if the key does not expire
	 */
	public async expires(key: Key): Promise<Date | undefined> {
		await this.doInitialHydrate();
		this.logMessage('expires', `get expire key: '${key}'`);
		await this.cleanExpired(TachyonBandwidth.Normal);
		const entry = this.cache.get(key);
		return entry?.expires ? new Date(entry.expires) : undefined;
	}

	/**
	 * Clear the cache
	 * - stores: TachyonBandwidth.VerySmall (any driver bandwidth)
	 * @returns Promise<void> - resolves when the cache is cleared
	 */
	public async clear(): Promise<void> {
		await this.doInitialHydrate();
		const deleteData = this.buildFlatDataMap();
		this.logMessage('clear', `clear: ${deleteData.size.toString()} keys`);
		this.cache.clear();
		await this.notifyClear(deleteData);
		return this.handleStore(TachyonBandwidth.VerySmall);
	}

	public async size(): Promise<number> {
		await this.doInitialHydrate();
		this.logMessage('size', `size: ${this.cache.size.toString()}`);
		return this.cache.size;
	}

	/**
	 * Close the cache
	 * @returns Promise<void> - resolves when the cache is closed
	 */
	public async close(): Promise<void> {
		this.logMessage('close', 'close cache');
		await this.driver.unload();
	}

	/**
	 * Initialize the cache (else do lazy initialization on first call)
	 */
	public async init(): Promise<void> {
		this.logMessage('init', 'initialize cache');
		await this.driver.init();
		await this.doInitialHydrate();
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
				this.handleRebuild(data);
			}
			this.isHydrated = true;
			this.hydratePromise = undefined;
			// if the driver has a bandwidth of VerySmall, we do clean on startup
			if (this.driver.bandwidth === TachyonBandwidth.VerySmall) {
				await this.cleanExpired(TachyonBandwidth.VerySmall);
			}
		}
	}

	/**
	 * Handle the update event from the driver and merge the data into the cache
	 * @param data - the data to update the cache with
	 */
	private async handleUpdate(data: CacheMap<Payload, Key>) {
		let isModified = false;
		for (const [key, value] of data.entries()) {
			const cacheValue = this.cache.get(key);
			// only update if the value is undefined or the expires value has changed
			if (!cacheValue || cacheValue.expires !== value.expires) {
				isModified = true;
				this.cache.set(key, value);
			}
		}
		if (isModified) {
			this.logMessage('update', 'update Cache Map');
			await this.handleStore(TachyonBandwidth.VerySmall);
		}
	}

	private handleRebuild(data: CacheMap<Payload, Key>) {
		this.logMessage('rebuild', `hydrate rebuild Cache Map: size=${data.size.toString()}`);
		this.cache = data;
	}

	/**
	 * this function will handle the store operation
	 * - if the bandwidth is VerySmall, it will do cleanup to expired data (minimize write operations)
	 * @param limit - the bandwidth limit to use for the store operation
	 */
	private async handleStore(limit: TachyonBandwidth): Promise<void> {
		const deleteData = this.handleExpires();
		if (this.testBandwidth(limit)) {
			await this.writeStore();
		}
		if (deleteData.size > 0) {
			this.logMessage('cleanExpired', `expired count: ${deleteData.size.toString()}`);
			await this.notifyClear(deleteData);
		}
	}

	private async cleanExpired(limit: TachyonBandwidth): Promise<void> {
		const deleteData = this.handleExpires();
		if (deleteData.size > 0) {
			this.logMessage('cleanExpired', `expired count: ${deleteData.size.toString()}`);
			if (this.testBandwidth(limit)) {
				await this.writeStore();
			}
			await this.notifyClear(deleteData);
		}
	}

	/**
	 * Actual 'store' operation to the storage driver
	 */
	private async writeStore(): Promise<void> {
		this.logMessage('store', `store: size=${this.cache.size.toString()}`);
		this.isWriting = true; // lock updates from driver as we are writing
		await this.driver.store(this.cache);
		// release the write lock after 100ms
		setTimeout(() => {
			this.isWriting = false;
		}, 100);
	}

	private handleExpires(): Map<Key, Payload> {
		const deleteData = new Map<Key, Payload>();
		const now = new Date().getTime();
		for (const [key, value] of this.cache.entries()) {
			if (value.expires !== undefined && value.expires < now) {
				deleteData.set(key, value.data);
				this.cache.delete(key);
			}
		}
		return deleteData;
	}

	private async notifyClear(deleteData: Map<Key, Payload>): Promise<void> {
		await Promise.all(this.onClearCallbacks.map((callback) => callback?.(deleteData)));
	}

	private testBandwidth(limit: TachyonBandwidth): boolean {
		return this.driver.bandwidth <= limit;
	}

	private logMessage(key: keyof ExpireCacheLogMapType, message: string): void {
		this.logKey(key, `${this.constructor.name}[${this.name}]: ${message}`);
	}

	public toString(): string {
		return `${this.constructor.name}[${this.name}], driver: ${this.driver.name}, size: ${this.cache.size.toString()}, defaultExpireMs: ${this.defaultExpireMs?.toString() ?? 'undefined'}`;
	}

	public toJSON(): {defaultExpireMs: number | undefined; driver: string; name: string; size: number} {
		return {
			defaultExpireMs: this.defaultExpireMs,
			driver: this.driver.name,
			name: this.name,
			size: this.cache.size,
		};
	}
}
