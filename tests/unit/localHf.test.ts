import { describe, expect, it } from 'vitest'
import {
  HfClient,
  hfModelUrl,
  hfResolveUrl,
  hfSearchUrl,
  isRepoId,
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

describe('hf repo ids', () => {
  it('accepts only org/repo and rejects path escapes', () => {
    expect(isRepoId('org/repo')).toBe(true)
    expect(isRepoId('../etc')).toBe(false)
    expect(isRepoId('org')).toBe(false)
    expect(isRepoId('a/b/c')).toBe(false)
    expect(isRepoId(null)).toBe(false)
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
    // null / 数字 / rfilename 非字符串的 sibling 都是上游可能出现的异常形状，必须静默跳过而不是抛错。
    const detail = parseHfModel('org/repo', {
      siblings: [null, 5, { rfilename: 42 }, { rfilename: 'model.gguf' }]
    })
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
    let headers: Record<string, string> = {}
    const client = new HfClient({
      fetchFn: async (url, init) => {
        urls.push(url)
        headers = (init?.headers ?? {}) as Record<string, string>
        return new Response('denied', { status: 401 })
      },
      baseUrl: () => 'https://huggingface.co',
      token: () => 'hf_x'
    })
    await expect(client.search('qwen')).rejects.toThrow('Token')
    expect(urls[0]).toContain('/api/models?search=qwen')
    expect(headers.Authorization).toBe('Bearer hf_x')
  })

  it('bounds every request with an abort signal', async () => {
    let init: RequestInit | undefined
    const client = new HfClient({
      fetchFn: async (_url, options) => {
        init = options
        return new Response(JSON.stringify([{ id: 'org/repo' }]), { status: 200 })
      },
      baseUrl: () => 'https://huggingface.co',
      token: () => null
    })
    await client.search('qwen')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps a non-JSON 200 body to an unreadable-response error', async () => {
    const client = new HfClient({
      fetchFn: async () =>
        new Response('<html>please sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      baseUrl: () => 'https://hf-mirror.com',
      token: () => null
    })
    await expect(client.search('qwen')).rejects.toThrow('HF 响应无法解析')
  })

  it('maps a timeout while reading the body to a request-timeout error', async () => {
    // 镜像先回 200 响应头、body 挂死：AbortSignal.timeout 会在 json() 里抛 TimeoutError，须报超时而非解析失败。
    const client = new HfClient({
      fetchFn: async () =>
        ({
          status: 200,
          ok: true,
          json: async () => {
            throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
          }
        }) as unknown as Response,
      baseUrl: () => 'https://hf-mirror.com',
      token: () => null
    })
    await expect(client.search('qwen')).rejects.toThrow('HF 请求失败：请求超时（15 秒无响应）')
  })

  it('maps a fetch rejection to a request-failed error', async () => {
    const client = new HfClient({
      fetchFn: async () => {
        throw new Error('getaddrinfo ENOTFOUND hf-mirror.com')
      },
      baseUrl: () => 'https://hf-mirror.com',
      token: () => null
    })
    await expect(client.model('org/repo')).rejects.toThrow('HF 请求失败：getaddrinfo ENOTFOUND hf-mirror.com')
  })

  it('maps an aborted request to a timeout message', async () => {
    const client = new HfClient({
      fetchFn: async () => {
        // AbortSignal.timeout 在 fetch 内部抛出的就是 name 为 TimeoutError 的错误。
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      },
      baseUrl: () => 'https://hf-mirror.com',
      token: () => null
    })
    await expect(client.search('qwen')).rejects.toThrow('HF 请求失败：请求超时')
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