# tachyon-expire-cache

TachyonExpireCache is a cache class that allows you to add expiration for data. <br/>
It implements the generic IAsyncCache interface from '@avanio/expire-cache' and uses the IStorageDriver interface from the "tachyon-drive" to support different storage drivers.

## Installation

```bash
npm install tachyon-expire-cache
```

## Validation and serialization type

```typescript
type CacheMap<Key, Payload> = Map<Key, {data: Payload; expires: number | undefined}>;
```

## Usage

Example with FileStorageDriver and BufferSerializer with zod validation

```typescript
import {TachyonExpireCache, CacheMap} from 'tachyon-expire-cache';
import {IPersistSerializer, MemoryStorageDriver} from 'tachyon-drive';

// type CachePayload<Payload> = {data: Payload; expires: number | undefined};
function cachePayloadSchema<T>(data: z.Schema<T>) {
	return z.object({
		data,
		expires: z.number().optional(),
	});
}

// type CacheMap<Payload, Key = string> = Map<Key, CachePayload<Payload>>
const bufferSerializer: IPersistSerializer<CacheMap<string, string>, Buffer> = {
	serialize: (data: CacheMap<string, string>) => Buffer.from(JSON.stringify(Array.from(data))),
	deserialize: (buffer: Buffer) => new Map(JSON.parse(buffer.toString())),
	validator: (data: CacheMap<string, string>) => z.map(z.string(), cachePayloadSchema(z.string())).safeParse(data).success,
};

const cache = new TachyonExpireCache<string, string>(new FileStorageDriver('FileStorageDriver', './cache.json', bufferSerializer));

await cache.set('key', 'value', new Date(Date.now() + 1000));

await cache.get('key'); // 'value'

await cache.has('key'); // true

await cache.delete('key'); // true

await cache.clear();

await cache.size(); // number of items in cache
```
