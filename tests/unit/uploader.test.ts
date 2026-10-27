import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '@/lib/client/uploader';

afterEach(() => vi.unstubAllGlobals());

describe('resumable uploads', () => {
  it('retries a lost completion response without starting another upload', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const complete = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue({ status: 'processing' });
    const options = {
      file: new Blob(['file']),
      resumeKey: 'test-file',
      begin: vi.fn().mockResolvedValue({ upload_id: 'upload-1', part_size: 4, part_count: 1 }),
      status: vi.fn().mockResolvedValue({ status: 'processing', part_size: 4, part_count: 1, uploaded_parts: [] }),
      sign: vi.fn().mockResolvedValue({ parts: [{ part_number: 1, url: 'https://storage.example.test/part' }] }),
      complete,
    };
    await expect(uploadFile(options)).rejects.toThrow('connection lost');
    expect(stored.size).toBe(1);
    await expect(uploadFile(options)).resolves.toEqual({ status: 'processing' });
    expect(options.begin).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });
});
