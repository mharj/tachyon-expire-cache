import {IAsyncCache, IAsyncCacheOnClearCallback} from '@avanio/expire-cache';
import {ILoggerLike, LogLevel, LogMapping, MapLogger} from '@avanio/logger-like';
import {IStorageDriver} from 'tachyon-drive';

function toAsyncIterableIterator<T>(iterable: IterableIterator<T>): AsyncIterableIterator<T> {
	return (async function* () {
		for (const value of iterable) {
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
	keys: LogLevel.None,
	set: LogLevel.None,
	size: LogLevel.None,
	values: LogLevel.None,
} as const;

export type ExpireCacheLogMapType = LogMapping<keyof typeof defaultLogMap>;

export type CachePayload<Payload> = {data: Payload; expires: number | undefined};

export type CacheMap<Payload, Key = string> = Map<Key, CachePayload<Payload>>;

/**
 * TachyonExpireCache implements IAsyncCache using a Tachyon storage driver to persist the cache.
 *
 * Data is stored as a ```CacheMap<Payload, Key = string>``` if building validation for serialization.
 */
export class TachyonExpireCache<Payload, Key = string> extends MapLogger<ExpireCacheLogMapType> implements IAsyncCache<Payload, Key> {
	private cache = new Map<Key, {data: Payload; expires: number | undefined}>();
	private defaultExpireMs: undefined | number;
	private driver: IStorageDriver<Map<Key, {data: Payload; expires: number | undefined}>>;
	private isHydrated = false;
	private onClearCallbacks = new Set<IAsyncCacheOnClearCallback<Payload, Key>>();

	constructor(
		driver: IStorageDriver<Map<Key, {data: Payload; expires: number | undefined}>>,
		logger?: ILoggerLike,
		logMapping?: ExpireCacheLogMapType,
		defaultExpireMs?: number,
	) {
		super(logger, Object.assign({}, defaultLogMap, logMapping));
		this.driver = driver;
		this.defaultExpireMs = defaultExpireMs;
		this.driver.onUpdate((data) => {
			if (data) {
				this.cache = data;
			}
		});
	}

	public onClear(callback: IAsyncCacheOnClearCallback<Payload, Key>): void {
		this.onClearCallbacks.add(callback);
	}

	public entries(): AsyncIterableIterator<[Key, Payload]> {
		this.logKey('entries', 'TachyonExpireCache entries');
		return toAsyncIterableIterator(this.buildFlatDataMap().entries());
	}

	public keys(): AsyncIterableIterator<Key> {
		this.logKey('keys', 'TachyonExpireCache keys');
		return toAsyncIterableIterator(this.cache.keys());
	}

	public values(): AsyncIterableIterator<Payload> {
		this.logKey('values', 'TachyonExpireCache values');
		return toAsyncIterableIterator(this.buildFlatDataMap().values());
	}

	private buildFlatDataMap(): Map<Key, Payload> {
		return new Map(Array.from(this.cache.entries()).map(([key, value]) => [key, value.data]));
	}

	public async get(key: Key): Promise<Payload | undefined> {
		this.logKey('get', `TachyonExpireCache get key: ${key}`);
		await this.doInitialHydrate();
		await this.cleanExpired();
		return this.cache.get(key)?.data;
	}

	public async set(key: Key, data: Payload, expires?: Date | undefined): Promise<void> {
		const expireTs: number | undefined = expires?.getTime() ?? (this.defaultExpireMs && Date.now() + this.defaultExpireMs);
		this.logKey('set', `TachyonExpireCache set key: ${key}, expireTs: ${expireTs}`);
		this.cache.set(key, {data, expires: expireTs});
		await this.doInitialHydrate();
		await this.driver.store(this.cache);
	}

	public async delete(key: Key): Promise<boolean> {
		this.logKey('delete', `TachyonExpireCache delete key: ${key}`);
		const value = this.cache.get(key);
		if (value) {
			const deleteData = new Map<Key, Payload>();
			deleteData.set(key, value.data);
			const isDeleted = this.cache.delete(key);
			await this.doInitialHydrate();
			await this.driver.store(this.cache);
			this.onClearCallbacks.forEach((callback) => callback(deleteData));
			return isDeleted;
		}
		return false;
	}

	public async has(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logKey('has', `TachyonExpireCache has key: ${key}`);
		this.cleanExpired();
		return this.cache.has(key);
	}

	public async expires(key: Key): Promise<Date | undefined> {
		await this.doInitialHydrate();
		this.logKey('expires', `TachyonExpireCache get expire key: ${key}`);
		this.cleanExpired();
		const entry = this.cache.get(key);
		return entry?.expires ? new Date(entry.expires) : undefined;
	}

	public clear(): Promise<void> {
		this.logKey('clear', `TachyonExpireCache clear`);
		const deleteData = this.buildFlatDataMap();
		this.cache.clear();
		this.onClearCallbacks.forEach((callback) => callback(deleteData));
		return this.driver.store(this.cache);
	}

	public async size(): Promise<number> {
		await this.doInitialHydrate();
		this.logKey('size', `TachyonExpireCache size: ${this.cache.size}`);
		return this.cache.size;
	}

	private async doInitialHydrate(): Promise<void> {
		if (!this.isHydrated) {
			const data = await this.driver.hydrate();
			if (data) {
				this.cache = data;
			}
			this.isHydrated = true;
		}
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
			this.logKey('cleanExpired', `TachyonExpireCache expired count: ${deleteData.size}`);
			await this.driver.store(this.cache);
			this.onClearCallbacks.forEach((callback) => callback(deleteData));
		}
	}
}
