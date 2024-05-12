/* eslint-disable no-unused-expressions */
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import {type CacheMap, type ExpireCacheLogMapType, TachyonExpireCache} from '../src';
import {type ILoggerLike, LogLevel} from '@avanio/logger-like';
import {type IPersistSerializer, TachyonBandwidth} from 'tachyon-drive';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {FileStorageDriver} from 'tachyon-drive-node-fs';
import sinon from 'sinon';
import {z} from 'zod';

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const testLogMap = {
	cleanExpired: LogLevel.Debug,
	clear: LogLevel.Debug,
	close: LogLevel.Debug,
	constructor: LogLevel.Debug,
	delete: LogLevel.Debug,
	entries: LogLevel.Debug,
	expires: LogLevel.Debug,
	get: LogLevel.Debug,
	has: LogLevel.Debug,
	hydrate: LogLevel.Debug,
	init: LogLevel.Debug,
	keys: LogLevel.Debug,
	rebuild: LogLevel.Debug,
	set: LogLevel.Debug,
	size: LogLevel.Debug,
	store: LogLevel.Debug,
	update: LogLevel.Debug,
	values: LogLevel.Debug,
} satisfies ExpireCacheLogMapType;

const logSpy = sinon.spy();
const spyLogger = {
	debug: logSpy,
	error: logSpy,
	info: logSpy,
	warn: logSpy,
} satisfies ILoggerLike;

chai.use(chaiAsPromised);

const expect = chai.expect;

const onClearSpy = sinon.spy();

function cachePayloadSchema<T>(data: z.Schema<T>) {
	return z.object({
		data,
		expires: z.number().optional(),
	});
}

const bufferSerializer: IPersistSerializer<CacheMap<string, string>, Buffer> = {
	serialize: (data: CacheMap<string, string>) => Buffer.from(JSON.stringify(Array.from(data))),
	deserialize: (buffer: Buffer) => new Map(JSON.parse(buffer.toString())),
	validator: (data: CacheMap<string, string>) => z.map(z.string(), cachePayloadSchema(z.string())).safeParse(data).success,
};

const options = {logger: spyLogger, logMapping: testLogMap};

const fastDriver = new FileStorageDriver('FileStorageDriver', {fileName: './cache-test.json'}, bufferSerializer);

const slowDriver = new FileStorageDriver('FileStorageDriver', {fileName: './cache-test.json', bandwidth: TachyonBandwidth.VerySmall}, bufferSerializer);

let cache: TachyonExpireCache<string, string>;

describe('TachyonExpireCache', () => {
	describe('fast driver', function () {
		before(async () => {
			await fastDriver.clear();
			cache = new TachyonExpireCache<string, string>('Unit-Test', fastDriver, options);
			cache.onClear(onClearSpy);
		});
		beforeEach(() => {
			onClearSpy.resetHistory();
			logSpy.resetHistory();
		});
		it('should return undefined value if not cached yet', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: hydrate`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should store value to cache 1.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should return cached value', async () => {
			await expect(cache.get('key')).to.eventually.be.equal('value');
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should check that key exists', async () => {
			await expect(cache.has('key')).to.eventually.be.equal(true);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: has key: 'key'`);
		});
		it('should check cache size', async () => {
			await expect(cache.size()).to.eventually.be.equal(1);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: size: 1`);
		});
		it('should get key with is expired', async () => {
			const expires = new Date(Date.now() + 20);
			await cache.set('key', 'value', expires); // expired already
			// sleep 100ms
			await sleep(100);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: ${expires.getTime()}`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should return undefined value if expired', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(onClearSpy.callCount).to.be.eq(1);
			expect(logSpy.callCount).to.be.eq(3);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: expired count: 1`);
			expect(logSpy.getCall(2).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
		});
		it('should store value to cache 2.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should delete value from cache', async () => {
			expect(await cache.delete('key')).to.be.true;
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: delete key: 'key'`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		it('should return undefined value if deleted', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should store value to cache 3.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should clear cache', async () => {
			await cache.clear();
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: clear: 1 keys`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		it('should return undefined value if cleared', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should restore state and return cached value', async () => {
			await cache.set('key', 'value');
			cache = new TachyonExpireCache<string, string>('Unit-Test', fastDriver, options);
			cache.onClear(onClearSpy);
			await expect(cache.get('key')).to.eventually.be.equal('value');
			expect(onClearSpy.callCount).to.be.eq(0);
		});
		it('should return valid entry expire Date', async () => {
			const expires = new Date(Date.now() + 1000);
			await cache.set('key', 'value', expires);
			const value = await cache.expires('key');
			expect(value?.getTime()).to.be.eq(expires.getTime());
			await cache.clear();
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		it('should get toString()', async () => {
			expect(cache.toString()).to.be.eq('TachyonExpireCache[Unit-Test], driver: FileStorageDriver, size: 0, defaultExpireMs: undefined');
		});
		it('should get toJSON()', async () => {
			expect(JSON.stringify(cache.toJSON())).to.be.eq('{"driver":"FileStorageDriver","name":"Unit-Test","size":0}');
		});
		after(async () => {
			await fastDriver.clear();
			await cache.close();
		});
	});
	describe('slow driver', function () {
		before(async () => {
			// setup initial data to cache (use fast driver to store expired data)
			await slowDriver.clear();
			cache = new TachyonExpireCache<string, string>('Unit-Test', slowDriver, options);
			await cache.set('key', 'value', new Date(Date.now() + 200)); // expire soon
			await cache.close();
			cache = new TachyonExpireCache<string, string>('Unit-Test', slowDriver, options);
			cache.onClear(onClearSpy);
			await sleep(500);
		});
		beforeEach(() => {
			onClearSpy.resetHistory();
			logSpy.resetHistory();
		});
		it('should return undefined value if not cached yet', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(onClearSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: hydrate`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: hydrate rebuild Cache Map: size=1`);
			expect(logSpy.getCall(2).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: expired count: 1`);
			expect(logSpy.getCall(3).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
			expect(logSpy.getCall(4).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
			expect(logSpy.callCount).to.be.eq(5);
		});
		it('should store value to cache 1.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should return cached value', async () => {
			await expect(cache.get('key')).to.eventually.be.equal('value');
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should check that key exists', async () => {
			await expect(cache.has('key')).to.eventually.be.equal(true);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: has key: 'key'`);
		});
		it('should check cache size', async () => {
			await expect(cache.size()).to.eventually.be.equal(1);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: size: 1`);
		});
		it('should get key with is expired', async () => {
			const expires = new Date(Date.now() + 20);
			await cache.set('key', 'value', expires);
			// sleep 100ms
			await sleep(100);
			expect(onClearSpy.callCount).to.be.eq(0);
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: ${expires.getTime()}`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should return undefined value if expired', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(onClearSpy.callCount).to.be.eq(1);
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: expired count: 1`);
		});
		it('should store value to cache 2.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should delete value from cache', async () => {
			expect(await cache.delete('key')).to.be.true;
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: delete key: 'key'`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		it('should return undefined value if deleted', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should store value to cache 3.', async () => {
			await cache.set('key', 'value');
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=1`);
		});
		it('should clear cache', async () => {
			await cache.clear();
			expect(logSpy.callCount).to.be.eq(2);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: clear: 1 keys`);
			expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store: size=0`);
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		it('should return undefined value if cleared', async () => {
			await expect(cache.get('key')).to.eventually.be.undefined;
			expect(logSpy.callCount).to.be.eq(1);
			expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		});
		it('should restore state and return cached value', async () => {
			await cache.set('key', 'value');
			cache = new TachyonExpireCache<string, string>('Unit-Test', slowDriver, options);
			cache.onClear(onClearSpy);
			await expect(cache.get('key')).to.eventually.be.equal('value');
			expect(onClearSpy.callCount).to.be.eq(0);
		});
		it('should return valid entry expire Date', async () => {
			const expires = new Date(Date.now() + 1000);
			await cache.set('key', 'value', expires);
			const value = await cache.expires('key');
			expect(value?.getTime()).to.be.eq(expires.getTime());
			await cache.clear();
			expect(onClearSpy.callCount).to.be.eq(1);
		});
		after(async () => {
			await fastDriver.clear();
			expect(onClearSpy.callCount).to.be.eq(1);
			await cache.close();
		});
	});
});
