/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import {CacheMap, TachyonExpireCache} from '../src';
import {FileStorageDriver} from 'tachyon-drive-node-fs';
import {ICacheOrAsync} from '@avanio/expire-cache';
import {IPersistSerializer} from 'tachyon-drive';
import {z} from 'zod';

chai.use(chaiAsPromised);

const expect = chai.expect;

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
		cache = new TachyonExpireCache<string, string>(driver);
	});

	it('should return undefined value if not cached yet', async () => {
		await expect(cache.get('key')).to.eventually.be.undefined;
	});
	it('should return cached value', async () => {
		await cache.set('key', 'value');
		await expect(cache.get('key')).to.eventually.be.equal('value');
	});
	it('should check that key exists', async () => {
		await expect(cache.has('key')).to.eventually.be.equal(true);
	});
	it('should check cache size', async () => {
		await expect(cache.size()).to.eventually.be.equal(1);
	});
	it('should return undefined value if expired', async () => {
		await cache.set('key', 'value', new Date(Date.now() + 1)); // epires in 1ms
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(cache.get('key')).to.eventually.be.undefined;
	});
	it('should return undefined value if deleted', async () => {
		await cache.set('key', 'value');
		await cache.delete('key');
		await expect(cache.get('key')).to.eventually.be.undefined;
	});
	it('should return undefined value if cleared', async () => {
		await cache.set('key', 'value');
		await cache.clear();
		await expect(cache.get('key')).to.eventually.be.undefined;
	});
	it('should restore state and return cached value', async () => {
		await cache.set('key', 'value');
		cache = new TachyonExpireCache<string, string>(driver);
		await expect(cache.get('key')).to.eventually.be.equal('value');
	});
	after(async () => {
		await driver.clear();
	});
});
