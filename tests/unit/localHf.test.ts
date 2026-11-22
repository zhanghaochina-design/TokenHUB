import { describe, expect, it } from 'vitest'
import {
  HfClient,
  hfModelUrl,
  hfResolveUrl,
  hfSearchUrl,
  parseHfModel,
  parseHfSearch
} from '../../core/local/hf'

describe('hf urls', () => {
  it('builds search, detail and resolve urls with encoding', () => {
    expect(hfSearchUrl('https://huggingface.co', 'qwen 3')).toBe(
      'https://huggingface.co/api/models?search=qwen+3&filter=gguf&sort=downloads&direction=-1&limit=50'
    )
    expect(hfModelUrl('https://hf-mirror.com', 'Qwen/Qwen3-8B-GGUF')).toBe(
      'https://hf-mirror.com/api/models/Qwen/Qwen3-8B-GGUF?blobs=true'
    )
    expect(hfResolveUrl('https://hf-mirror.com', 'Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf')).toBe(
      'https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf'
    )
  })

  it('strips trailing slashes and encodes each path segment', () => {
    expect(hfSearchUrl('https://hf-mirror.com//', 'qwen')).toBe(
      'https://hf-mirror.com/api/models?search=qwen&filter=gguf&sort=downloads&direction=-1&limit=50'
    )
    expect(hfResolveUrl('https://hf-mirror.com', 'org/repo', 'sub dir/model #1.gguf')).toBe(
      'https://hf-mirror.com/org/repo/resolve/main/sub%20dir/model%20%231.gguf'
    )
  })
})

describe('hf parsing', () => {
  it('parses search results and licenses', () => {
    const models = parseHfSearch([
      { id: 'Qwen/Qwen3-8B-GGUF', downloads: 10, likes: 2, lastModified: '2026-01-01', tags: ['license:apache-2.0', 'gguf'], gated: false }
    ])
    expect(models[0]).toEqual({
      id: 'Qwen/Qwen3-8B-GGUF',
      downloads: 10,
      likes: 2,
      lastModified: '2026-01-01',
      license: 'apache-2.0',
      gated: false
    })
  })

  it('returns an empty list for non-array payloads', () => {
    expect(parseHfSearch(null)).toEqual([])
    expect(parseHfSearch({ error: 'nope' })).toEqual([])
  })

  it('coerces unparsable counters to zero', () => {
    expect(parseHfSearch([{ id: 'org/repo', downloads: 'many', likes: null }])[0]).toMatchObject({
      downloads: 0,
      likes: 0
    })
  })

  it('keeps only gguf files and detects quant, split and adapters', () => {
    const detail = parseHfModel('Qwen/Qwen3-8B-GGUF', {
      gated: 'auto',
      tags: ['license:apache-2.0'],
      siblings: [
        { rfilename: 'README.md', size: 100 },
        { rfilename: 'Qwen3-8B-Q4_K_M.gguf', size: 5000 },
        { rfilename: 'Qwen3-8B-Q8_0-00001-of-00002.gguf', lfs: { size: 9000 } },
        { rfilename: 'mmproj-F16.gguf', size: 300 }
      ]
    })
    expect(detail.gated).toBe(true)
    expect(detail.license).toBe('apache-2.0')
    expect(detail.files.map((file) => file.path)).toEqual([
      'Qwen3-8B-Q4_K_M.gguf',
      'Qwen3-8B-Q8_0-00001-of-00002.gguf',
      'mmproj-F16.gguf'
    ])
    expect(detail.files[0]).toMatchObject({ sizeBytes: 5000, quant: 'Q4_K_M', split: null, isAdapter: false })
    expect(detail.files[1]).toMatchObject({ sizeBytes: 9000, split: { part: 1, total: 2 } })
    expect(detail.files[2]).toMatchObject({ isAdapter: true })
  })

  it('treats missing or unknown fields as unlicensed and ungated', () => {
    const detail = parseHfModel('org/repo', { siblings: [{ rfilename: 'model.gguf' }] })
    expect(detail).toEqual({
      id: 'org/repo',
      license: null,
      gated: false,
      files: [{ path: 'model.gguf', sizeBytes: 0, quant: null, split: null, isAdapter: false }]
    })
  })
})

describe('HfClient', () => {
  it('sends the token and maps auth failures', async () => {
    const urls: string[] = []
    const client = new HfClient({
      fetchFn: async (url) => {
        urls.push(url)
        return new Response('denied', { status: 401 })
      },
      baseUrl: () => 'https://huggingface.co',
      token: () => 'hf_x'
    })
    await expect(client.search('qwen')).rejects.toThrow('Token')
    expect(urls[0]).toContain('/api/models?search=qwen')
  })

  it('maps 404 to a model-not-found error and rejects malformed repos', async () => {
    const client = new HfClient({
      fetchFn: async () => new Response('missing', { status: 404 }),
      baseUrl: () => 'https://huggingface.co',
      token: () => null
    })
    await expect(client.model('org/repo')).rejects.toThrow('模型不存在')
    await expect(client.model('org/repo/extra')).rejects.toThrow('org/repo')
    await expect(client.model('../etc')).rejects.toThrow('org/repo')
  })

  it('omits the authorization header without a token', async () => {
    let headers: Record<string, string> = {}
    const client = new HfClient({
      fetchFn: async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>
        return new Response(JSON.stringify([{ id: 'org/repo' }]), { status: 200 })
      },
      baseUrl: () => 'https://huggingface.co',
      token: () => null
    })
    const models = await client.search('qwen')
    expect(headers.Authorization).toBeUndefined()
    expect(models).toEqual([{ id: 'org/repo', downloads: 0, likes: 0, lastModified: '', license: null, gated: false }])
  })
})