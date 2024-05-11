/* eslint-disable no-unused-expressions */
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import {type CacheMap, type ExpireCacheLogMapType, TachyonExpireCache} from '../src';
import {type ILoggerLike, LogLevel} from '@avanio/logger-like';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {FileStorageDriver} from 'tachyon-drive-node-fs';
import {type ICacheOrAsync} from '@avanio/expire-cache';
import {type IPersistSerializer} from 'tachyon-drive';
import sinon from 'sinon';
import {z} from 'zod';

const testLogMap = {
	cleanExpired: LogLevel.Debug,
	clear: LogLevel.Debug,
	constructor: LogLevel.Debug,
	delete: LogLevel.Debug,
	entries: LogLevel.Debug,
	expires: LogLevel.Debug,
	get: LogLevel.Debug,
	has: LogLevel.Debug,
	hydrate: LogLevel.Debug,
	keys: LogLevel.Debug,
	rebuild: LogLevel.Debug,
	set: LogLevel.Debug,
	size: LogLevel.Debug,
	store: LogLevel.Debug,
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

const driver = new FileStorageDriver('FileStorageDriver', './cache-test.json', bufferSerializer);

let cache: ICacheOrAsync<string>;

describe('TachyonExpireCache', () => {
	before(async () => {
		await driver.clear();
		cache = new TachyonExpireCache<string, string>('Unit-Test', driver, spyLogger, testLogMap);
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
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
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
		const expires = new Date(Date.now() - 1);
		await cache.set('key', 'value', expires); // expired already
		expect(onClearSpy.callCount).to.be.eq(0);
		expect(logSpy.callCount).to.be.eq(2);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: ${expires.getTime()}`);
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
	});
	it('should return undefined value if expired', async () => {
		await expect(cache.get('key')).to.eventually.be.undefined;
		expect(onClearSpy.callCount).to.be.eq(1);
		expect(logSpy.callCount).to.be.eq(3);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: expired count: 1`);
		expect(logSpy.getCall(2).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
	});
	it('should store value to cache 2.', async () => {
		await cache.set('key', 'value');
		expect(logSpy.callCount).to.be.eq(2);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: set key: 'key', expireTs: undefined`);
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
	});
	it('should delete value from cache', async () => {
		expect(await cache.delete('key')).to.be.true;
		expect(logSpy.callCount).to.be.eq(2);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: delete key: 'key'`);
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
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
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
	});
	it('should clear cache', async () => {
		await cache.clear();
		expect(logSpy.callCount).to.be.eq(2);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: clear`);
		expect(logSpy.getCall(1).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: store`);
		expect(onClearSpy.callCount).to.be.eq(1);
	});
	it('should return undefined value if cleared', async () => {
		await expect(cache.get('key')).to.eventually.be.undefined;
		expect(logSpy.callCount).to.be.eq(1);
		expect(logSpy.getCall(0).args[0]).to.be.eq(`TachyonExpireCache[Unit-Test]: get with key: 'key'`);
	});
	it('should restore state and return cached value', async () => {
		await cache.set('key', 'value');
		cache = new TachyonExpireCache<string, string>('Unit-Test', driver);
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
		await driver.clear();
		expect(onClearSpy.callCount).to.be.eq(1);
	});
});
