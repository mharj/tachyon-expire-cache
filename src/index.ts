import {ILoggerLike, LogLevel, LogMapping, MapLogger} from '@avanio/logger-like';
import {IAsyncCache} from '@avanio/expire-cache';
import {IStorageDriver} from 'tachyon-drive';

/**
 * Default log map for ExpireCache method calls (no logs)
 */
const defaultLogMap = {
	cleanExpired: LogLevel.None,
	clear: LogLevel.None,
	constructor: LogLevel.None,
	delete: LogLevel.None,
	get: LogLevel.None,
	has: LogLevel.None,
	set: LogLevel.None,
	size: LogLevel.None,
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

	public async get(key: Key): Promise<Payload | undefined> {
		await this.doInitialHydrate();
		this.logKey('get', `TachyonExpireCache get key: ${key}`);
		this.cleanExpired();
		return this.cache.get(key)?.data;
	}

	public async set(key: Key, data: Payload, expires?: Date | undefined): Promise<void> {
		await this.doInitialHydrate();
		const expireTs: number | undefined = expires?.getTime() ?? (this.defaultExpireMs && Date.now() + this.defaultExpireMs);
		this.logKey('set', `TachyonExpireCache set key: ${key}, expireTs: ${expireTs}`);
		this.cache.set(key, {data, expires: expireTs});
		await this.driver.store(this.cache);
	}

	public async delete(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logKey('delete', `TachyonExpireCache delete key: ${key}`);
		const isDeleted = this.cache.delete(key);
		if (isDeleted) {
			await this.driver.store(this.cache);
		}
		return isDeleted;
	}

	public async has(key: Key): Promise<boolean> {
		await this.doInitialHydrate();
		this.logKey('has', `TachyonExpireCache has key: ${key}`);
		this.cleanExpired();
		return this.cache.has(key);
	}

	public clear(): Promise<void> {
		this.logKey('clear', `TachyonExpireCache clear`);
		this.cache.clear();
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
		let cleanCount = 0;
		const now = new Date().getTime();
		for (const [key, value] of this.cache.entries()) {
			if (value.expires !== undefined && value.expires < now) {
				this.cache.delete(key);
				cleanCount++;
			}
		}
		if (cleanCount > 0) {
			this.logKey('cleanExpired', `TachyonExpireCache expired count: ${cleanCount}`);
			await this.driver.store(this.cache);
		}
	}
}
