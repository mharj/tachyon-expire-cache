# tachyon-drive-node-fs

## NodeFS File Storage Driver for Tachyon Drive and Tachyon Drive Crypto processor

### Initialize simple JSON file storage driver

```typescript
const driver = new FileStorageDriver('FileStorageDriver', './store.json', bufferSerializer);
```

### Initialize crypt processor with JSON file storage driver

```typescript
const processor = new CryptoBufferProcessor(Buffer.from('some-secret-key'));
const driver = new FileStorageDriver('FileStorageDriver', './store.json.aes', bufferSerializer, processor);
```

### see more on NPMJS [tachyon-drive](https://www.npmjs.com/package/tachyon-drive)