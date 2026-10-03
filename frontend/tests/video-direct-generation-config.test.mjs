import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const aiConfigRoute = readFileSync(new URL('../../backend/src/routes/aiConfigs.ts', import.meta.url), 'utf8')
const volcengineAdapter = readFileSync(new URL('../../backend/src/services/adapters/volcengine-video.ts', import.meta.url), 'utf8')

test('video presets default to direct Seedance 2.0 generation', () => {
  const combined = `${settingsPage}\n${aiConfigRoute}\n${volcengineAdapter}`
  assert.doesNotMatch(combined, /doubao-seedance-1-5-pro-251215/)
  assert.match(settingsPage, /Seedance 2\.0/)
  assert.match(settingsPage, /doubao-seedance-2-0-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-fast-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-mini-260615/)
})

test('video presets use official provider endpoints', () => {
  const presetsStart = settingsPage.indexOf('const providerPresets = {')
  const quickStart = settingsPage.indexOf('const huobaoQuickConfigs = [')
  const providerPresets = settingsPage.slice(presetsStart, quickStart)
  assert.doesNotMatch(providerPresets, /api\.firemux\.com/)
  assert.match(settingsPage, /https:\/\/ark\.cn-beijing\.volces\.com/)
  assert.match(providerPresets, /https:\/\/\{WorkspaceId\}\.cn-beijing\.maas\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/dashscope\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.vidu\.com/)
})

test('Wan 3.0 quick preset targets the Qwen gateway namespace', () => {
  const quickStart = settingsPage.indexOf('const huobaoQuickConfigs = [')
  const quickConfigs = settingsPage.slice(quickStart)
  const wanPreset = quickConfigs.match(/\{ service_type: 'video', provider: 'aliyun',[^\r\n]+/)?.[0] || ''
  assert.match(wanPreset, /base_url:\s*'https:\/\/api\.firemux\.com\/qwen'/)
  assert.match(wanPreset, /'wan3\.0-video-prime'/)
  assert.match(wanPreset, /'wan3\.0-video'/)
})

// Exercise the page's actual request/validation helpers with mocked assets and API.
const episodePage = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
function pageFunction(name) {
  const start = episodePage.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'))
  assert.notEqual(start, -1, `missing page helper ${name}`)
  return episodePage.slice(start, episodePage.indexOf('\n}', start) + 2)
}
function videoHarness({ model = 'huobao_minimax_h3_reference_turbo_api', provider = 'comfyui', explicit = true } = {}) {
  const requests = []
  const errors = []
  const successes = []
  const continuityRequests = []
  const watchChecks = []
  const taskListing = { tasks: [], merges: [] }
  const extraction = { result: { first_frame_url: 'static/continuity/shot1-tail.png', source_storyboard_id: 1, source_storyboard_number: 1, source_video_url: 'static/videos/shot1.mp4' } }
  const pendingVideoIds = { value: [] }
  const batchVideoConfirm = { value: { open: false, targets: [] } }
  const assets = sb => [sb.scene, ...(sb.characters || []), ...(sb.props || [])].filter(Boolean)
  const context = {
    computed: getter => ({ get value() { return getter() } }),
    ref: value => ({ value }),
    selectedSb: { value: null },
    sbs: { value: [] },
    epId: { value: 1 },
    getVideoUrl: sb => sb?.video_url || sb?.videoUrl || null,
    hasVid: sb => !!(sb?.video_url || sb?.videoUrl),
    genTasks: { value: [] },
    genMerges: { value: [] },
    chars: { value: [] },
    scenes: { value: [] },
    propItems: { value: [] },
    api: { post: async url => {
      continuityRequests.push(url)
      extraction.beforeReturn?.()
      return extraction.result
    } },
    toastError: error => errors.push(error.message),
    selectedVideoConfig: { value: { provider, model: [model] } },
    videoModel: { value: explicit ? `${provider}/${model}` : '' },
    videoModelOptions: { value: [] },
    refImageLimit: { value: provider === 'aliyun' ? 10 : 9 },
    getStoryboardScene: sb => sb.scene,
    getStoryboardCharacters: sb => sb.characters || [],
    getStoryboardProps: sb => sb.props || [],
    shotBindableAssets: sb => assets(sb).map(asset => ({
      bound: true, imageUrl: asset.image_url || asset.imageUrl || '', name: asset.name || asset.location,
    })),
    toast: { error: message => errors.push(message), success: message => successes.push(message), info() {} },
    t: key => key,
    dramaId: 1,
    dramaAspectRatio: { value: '16:9' },
    pendingVideoIds,
    failedVideoMessages: { value: {} },
    taskAPI: {
      generate: async payload => { requests.push(structuredClone(payload)); return { id: 1 } },
      listByEpisode: async () => structuredClone(taskListing),
    },
    refresh: async () => {},
    pollVideoGeneration() {},
    batchVideoConfirm,
    watchAsyncResult: check => watchChecks.push(check),
    videoSelectMode: { value: false },
  }
  const helpers = ['configModels', 'bareModelName', 'ownerConfigId', 'getShotReferenceImages',
    'loadGenTasks', 'hasProcessingVideoTask', 'isPendingVideo', 'videoTaskState', 'videoFailMessage',
    'getStoryboardCharacterIds', 'getStoryboardPropIds',
    'getPreviousStoryboard', 'continuityFrameError', 'usePreviousVideoFrame', 'clearContinuityFrame',
    'motionContextError', 'usePreviousMotionContext', 'clearMotionContext',
    'getShotReferenceIndexMap', 'resolveVideoPromptRefs', 'validateVideoReferences',
    'genVid', 'openBatchVideoConfirm', 'confirmBatchVideos'].map(pageFunction).join('\n')
  const modelState = episodePage.slice(episodePage.indexOf('const effectiveVideoModelLabel = computed'),
    episodePage.indexOf('const episodeResolutionLabel = computed'))
  const api = runInNewContext(`${helpers}\n${modelState}\n;({ genVid, getShotReferenceImages, resolveVideoPromptRefs,
    openBatchVideoConfirm, confirmBatchVideos, videoReferenceHint, isComfyuiWanVideo, isComfyuiH3Video,
    getPreviousStoryboard, usePreviousVideoFrame, clearContinuityFrame, continuityFrames, continuityLoadingIds,
    motionContextError, usePreviousMotionContext, clearMotionContext, motionContextSources, selectedMotionContext,
     canUsePreviousFrame, canUseMotionContext, selectedContinuityFrame, loadGenTasks, hasProcessingVideoTask, isPendingVideo, videoTaskState })`, context)
  return { ...api, requests, errors, successes, batchVideoConfirm, continuityRequests, extraction, context, taskListing, watchChecks }
}
function loadBoundAssets(h, { characters = [], scenes = [], props = [] } = {}) {
  h.context.chars.value = characters
  h.context.scenes.value = scenes
  h.context.propItems.value = props
  const names = ['getStoryboardCharacters', 'getStoryboardScene', 'getStoryboardProps', 'shotBindableAssets', 'isNarratorCharacter']
  const lookups = runInNewContext(`${names.map(pageFunction).join('\n')}\n;({ ${names.join(', ')} })`, h.context)
  Object.assign(h.context, lookups)
  h.context.visualChars = { get value() { return h.context.chars.value.filter(char => !lookups.isNarratorCharacter(char)) } }
}

const shotWithReferences = () => ({
  id: 2,
  duration: 13,
  video_prompt: '@徐牧 走进 @张府牛棚',
  scene: { location: '张府牛棚', image_url: 'static/scenes/barn.png' },
  characters: [{ name: '徐牧', image_url: 'static/characters/xumu.png' }],
})

test('ComfyUI H3 preserves scene/character order and matching prompt indices', async () => {
  const h = videoHarness()
  await h.genVid(shotWithReferences())
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.requests[0].reference_image_urls, ['static/scenes/barn.png', 'static/characters/xumu.png'])
  assert.equal(h.requests[0].prompt, '@图片2徐牧 走进 @图片1张府牛棚')
  assert.equal(h.requests[0].duration, 13)
  assert.equal(h.requests[0].model, 'huobao_minimax_h3_reference_turbo_api')
  assert.equal('first_frame_url' in h.requests[0], false)
  assert.match(h.videoReferenceHint.value, /9 张独立参考图/)
})

test('ComfyUI Wan sends one explicit first frame and desugars indexed mentions', async () => {
  const h = videoHarness({ model: 'huobao_wan22_5b_t2v_32gb_api', explicit: false })
  const shot = { id: 1, video_prompt: '@图片1徐牧 起身', characters: [{ name: '徐牧', imageUrl: 'static/shot.png' }] }
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].first_frame_url, 'static/shot.png')
  assert.deepEqual(h.requests[0].reference_image_urls, [])
  assert.equal(h.requests[0].prompt, '@徐牧 起身')
  assert.match(h.videoReferenceHint.value, /第一帧/)
  await h.genVid({ id: 3, video_prompt: '镜头向前推进' })
  assert.equal(h.requests.length, 2)
  assert.equal('first_frame_url' in h.requests[1], false)
})

test('ComfyUI Wan rejects multiple refs before single or any batch submission', async () => {
  const h = videoHarness({ model: 'huobao_wan22_5b_t2v_32gb_api' })
  const shot = shotWithReferences()
  await h.genVid(shot)
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /2 张参考图.*H3/)
  const targets = [{ id: 1, video_prompt: 'text only' }, shot]
  h.openBatchVideoConfirm(targets)
  assert.equal(h.batchVideoConfirm.value.open, false)
  // Recheck at confirmation too: bindings/model can change while the dialog is open.
  h.batchVideoConfirm.value = { open: true, targets }
  h.confirmBatchVideos()
  assert.equal(h.requests.length, 0)
  assert.equal(h.successes.length, 0)
  assert.equal(h.batchVideoConfirm.value.open, true)
})

test('ComfyUI H3 accepts nine refs but rejects ten without silently truncating', async () => {
  const h = videoHarness()
  const shot = { id: 1, video_prompt: '@角色9 入场', characters: Array.from({ length: 9 }, (_, i) => ({
    name: `角色${i + 1}`, image_url: `static/${i + 1}.png`,
  })) }
  await h.genVid(shot)
  assert.equal(h.requests[0].reference_image_urls.length, 9)
  assert.equal(h.requests[0].prompt, '@图片9角色9 入场')
  shot.characters.push({ name: '角色10', image_url: 'static/10.png' })
  assert.equal(h.getShotReferenceImages(shot).length, 10)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.match(h.errors.at(-1), /9 张.*10 张/)
})

test('shared normalized image URLs keep both asset names on the same index', async () => {
  const h = videoHarness()
  const shot = shotWithReferences()
  shot.scene.image_url = ' static/shared.png '
  shot.characters[0].image_url = 'static/shared.png'
  await h.genVid(shot)
  assert.deepEqual(h.requests[0].reference_image_urls, ['static/shared.png'])
  assert.equal(h.requests[0].prompt, '@图片1徐牧 走进 @图片1张府牛棚')
})

test('ComfyUI does not silently ignore bound assets without images', async () => {
  const h = videoHarness()
  const shot = shotWithReferences()
  shot.characters[0].image_url = ''
  await h.genVid(shot)
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /徐牧.*尚无可用图片/)
})

test('unavailable bound characters, scenes, and props block single and batch generation', async () => {
  const character = { id: 11, name: '徐牧', image_url: 'static/characters/xumu.png' }
  const scene = { id: 21, location: '张府牛棚', image_url: 'static/scenes/barn.png' }
  const cases = [
    { bindings: { character_ids: [11], scene_id: 21 }, assets: { scenes: [scene] }, missing: /角色 #11/ },
    { bindings: { characterIds: [11], sceneId: 21 }, assets: { characters: [character] }, missing: /场景 #21/ },
    { bindings: { character_ids: [11], scene_id: 21, prop_ids: [31] }, assets: { characters: [character], scenes: [scene] }, missing: /道具 #31/ },
  ]
  for (const { bindings, assets, missing } of cases) {
    const h = videoHarness()
    loadBoundAssets(h, assets)
    const shot = { id: 2, video_prompt: '@徐牧 走进 @张府牛棚', ...bindings }
    await h.genVid(shot)
    assert.equal(h.requests.length, 0)
    assert.match(h.errors.at(-1), missing)
    assert.match(h.errors.at(-1), /已删除或未加载/)
    const targets = [{ id: 1, video_prompt: '空镜' }, shot]
    h.openBatchVideoConfirm(targets)
    assert.equal(h.batchVideoConfirm.value.open, false)
    h.batchVideoConfirm.value = { open: true, targets }
    h.confirmBatchVideos()
    assert.equal(h.requests.length, 0)
    assert.equal(h.successes.length, 0)
  }
})

test('loaded narrator bindings are intentionally excluded from visual reference validation', async () => {
  const h = videoHarness()
  loadBoundAssets(h, {
    characters: [{ id: 11, name: '旁白', role: 'narrator' }],
    scenes: [{ id: 21, location: '张府牛棚', image_url: 'static/scenes/barn.png' }],
  })
  await h.genVid({ id: 2, video_prompt: '@张府牛棚 空镜', character_ids: [11], scene_id: 21 })
  assert.equal(h.errors.length, 0)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.requests[0].reference_image_urls, ['static/scenes/barn.png'])
})

test('Wan explicit tail mode remains valid when unused bound asset IDs are unavailable', async () => {
  const h = videoHarness({ model: 'huobao_wan22_5b_t2v_32gb_api' })
  loadBoundAssets(h)
  const { shot } = continuityShots(h, { id: 2, video_prompt: '继续向前', character_ids: [11], scene_id: 21, prop_ids: [31] })
  await h.usePreviousVideoFrame(shot)
  await h.genVid(shot)
  assert.equal(h.errors.length, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].first_frame_url, 'static/continuity/shot1-tail.png')
  assert.deepEqual(h.requests[0].reference_image_urls, [])
})

test('official providers and legacy ComfyUI model IDs retain reference semantics', async () => {
  const official = videoHarness({ provider: 'minimax', model: 'MiniMax-H3' })
  const legacy = videoHarness({ model: 'zib+zit+最大程度保持原样双采+' })
  for (const h of [official, legacy]) {
    await h.genVid(shotWithReferences())
    assert.equal(h.requests[0].reference_image_urls.length, 2)
    assert.equal('first_frame_url' in h.requests[0], false)
    assert.equal(h.isComfyuiWanVideo.value, false)
    assert.equal(h.isComfyuiH3Video.value, false)
    assert.equal(h.videoReferenceHint.value, '')
  }
  assert.equal(legacy.requests[0].model, 'zib+zit+最大程度保持原样双采+')
})

function continuityShots(h, shot = shotWithReferences()) {
  const previous = { id: 1, episode_id: 1, storyboard_number: 1, video_url: 'static/videos/shot1.mp4' }
  Object.assign(shot, { episode_id: 1, storyboard_number: 2 })
  h.context.sbs.value = [shot, previous]
  h.context.selectedSb.value = shot
  return { shot, previous }
}

test('H3 explicitly selects and removes a previous tail frame while retaining named refs', async () => {
  const h = videoHarness()
  const { shot } = continuityShots(h)
  assert.equal(h.selectedContinuityFrame.value, null)
  assert.equal(h.canUsePreviousFrame.value, true)
  await h.usePreviousVideoFrame(shot)
  assert.deepEqual(h.continuityRequests, ['/storyboards/2/continuity-frame'])
  assert.equal(h.requests.length, 0, 'extracting a frame must not start generation')
  assert.equal(h.selectedContinuityFrame.value.sourceStoryboardNumber, 1)
  assert.match(h.videoReferenceHint.value, /首帧.*9 张独立参考图/)
  await h.genVid(shot)
  assert.equal(h.requests[0].first_frame_url, 'static/continuity/shot1-tail.png')
  assert.deepEqual(h.requests[0].reference_image_urls, ['static/scenes/barn.png', 'static/characters/xumu.png'])
  assert.equal(h.requests[0].prompt, '@图片2徐牧 走进 @图片1张府牛棚')
  h.clearContinuityFrame(shot)
  assert.equal(h.selectedContinuityFrame.value, null)
  await h.genVid(shot)
  assert.equal('first_frame_url' in h.requests[1], false)
})

test('H3 Motion Context explicitly selects the previous latent chain and keeps bound refs', async () => {
  const h = videoHarness()
  const { shot } = continuityShots(h)
  assert.equal(h.canUseMotionContext.value, true)
  h.usePreviousMotionContext(shot)
  assert.equal(h.requests.length, 0)
  assert.equal(h.selectedMotionContext.value.sourceStoryboardId, 1)
  await h.genVid(shot)
  assert.equal(h.requests[0].continuity_mode, 'motion_context')
  assert.equal(h.requests[0].continuity_source_storyboard_id, 1)
  assert.equal('first_frame_url' in h.requests[0], false)
  assert.deepEqual(h.requests[0].reference_image_urls, ['static/scenes/barn.png', 'static/characters/xumu.png'])
  h.clearMotionContext(shot)
  assert.equal(h.selectedMotionContext.value, null)
})

test('Wan cannot select H3 Motion Context', () => {
  const h = videoHarness({ model: 'huobao_wan22_5b_t2v_32gb_api' })
  const { shot } = continuityShots(h)
  assert.equal(h.canUseMotionContext.value, false)
  h.usePreviousMotionContext(shot)
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /ComfyUI MiniMax H3/)
})

test('Wan explicit continuity uses only the tail frame without changing asset bindings', async () => {
  const h = videoHarness({ model: 'huobao_wan22_5b_t2v_32gb_api' })
  const { shot } = continuityShots(h)
  await h.usePreviousVideoFrame(shot)
  assert.match(h.videoReferenceHint.value, /唯一首帧.*本次不使用单独绑定/)
  await h.genVid(shot)
  assert.equal(h.requests[0].first_frame_url, 'static/continuity/shot1-tail.png')
  assert.deepEqual(h.requests[0].reference_image_urls, [])
  assert.equal(h.requests[0].prompt, '@徐牧 走进 @张府牛棚')
  assert.equal(h.getShotReferenceImages(shot).length, 2)
  h.clearContinuityFrame(shot)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.match(h.errors.at(-1), /2 张参考图.*H3/)
})

test('continuity uses the immediately preceding same-episode shot and never skips an unfinished shot', async () => {
  const h = videoHarness()
  const { shot } = continuityShots(h)
  shot.storyboard_number = 3
  const preceding = { id: 4, episode_id: 1, storyboard_number: 2 }
  h.context.sbs.value.push(preceding, { id: 9, episode_id: 99, storyboard_number: 2, video_url: 'other.mp4' })
  assert.equal(h.getPreviousStoryboard(shot).id, 4)
  assert.equal(h.canUsePreviousFrame.value, false)
  await h.usePreviousVideoFrame(shot)
  assert.equal(h.continuityRequests.length, 0)
  assert.equal(h.selectedContinuityFrame.value, null)
  assert.match(h.errors.at(-1), /先完成上一分镜/)
})

test('stale or unsupported continuity and batches regenerating its source submit nothing', async () => {
  const h = videoHarness()
  const { shot, previous } = continuityShots(h)
  await h.usePreviousVideoFrame(shot)
  h.batchVideoConfirm.value = { open: true, targets: [previous, shot] }
  h.confirmBatchVideos()
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /批量任务包含接续首帧的来源分镜/)
  previous.video_url = 'static/videos/replaced.mp4'
  await h.genVid(shot)
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /视频或顺序已变化/)
  previous.video_url = 'static/videos/shot1.mp4'
  h.context.selectedVideoConfig.value.provider = 'minimax'
  await h.genVid(shot)
  assert.equal(h.requests.length, 0)
  assert.match(h.errors.at(-1), /当前模型不支持接续首帧/)
})

test('changed sources during extraction are rejected and frame-only H3 requests remain valid', async () => {
  const h = videoHarness()
  const { shot, previous } = continuityShots(h, { id: 2, video_prompt: '' })
  h.extraction.beforeReturn = () => { previous.video_url = 'static/videos/new.mp4' }
  await h.usePreviousVideoFrame(shot)
  assert.equal(h.selectedContinuityFrame.value, null)
  assert.equal(h.continuityLoadingIds.value.length, 0)
  assert.match(h.errors.at(-1), /上一分镜已变化/)
  delete h.extraction.beforeReturn
  h.extraction.result.source_video_url = previous.video_url
  await h.usePreviousVideoFrame(shot)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].first_frame_url, 'static/continuity/shot1-tail.png')
  assert.deepEqual(h.requests[0].reference_image_urls, [])
  assert.equal(h.requests[0].prompt, '')
})

test('refresh keeps an old-video source pending during regeneration and rejects its selected tail', async () => {
  const h = videoHarness()
  const { shot, previous } = continuityShots(h)
  previous.video_prompt = '镜头向前推进'
  await h.usePreviousVideoFrame(shot)
  h.taskListing.tasks = [
    { id: 10, type: 'video', storyboard_id: previous.id, status: 'completed', created_at: '2026-05-27T10:00:00Z' },
    { id: 11, type: 'video', storyboard_id: previous.id, status: 'processing', created_at: '2026-05-27T11:00:00Z' },
  ]
  h.context.refresh = h.loadGenTasks
  await h.genVid(previous)
  assert.equal(h.requests.length, 1)
  assert.equal(previous.video_url, 'static/videos/shot1.mp4')
  assert.equal(h.context.pendingVideoIds.value.includes(previous.id), true)
  assert.equal(h.videoTaskState(previous), 'pending')
  assert.equal(h.canUsePreviousFrame.value, false)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.match(h.errors.at(-1), /上一分镜的视频或顺序已变化/)

  // Cached processing tasks remain authoritative even if another poll clears local IDs.
  h.context.pendingVideoIds.value = []
  assert.equal(h.isPendingVideo(previous.id), true)
  await h.usePreviousVideoFrame(shot)
  assert.equal(h.continuityRequests.length, 1)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)

  h.taskListing.tasks[1].status = 'completed'
  previous.video_url = 'static/videos/shot1-new.mp4'
  await h.loadGenTasks()
  assert.equal(h.isPendingVideo(previous.id), false)
  assert.equal(h.videoTaskState(previous), 'done')
  await h.genVid(shot)
  assert.equal(h.requests.length, 1, 'a changed video still requires a fresh explicit frame selection')
})

test('batch and fallback watchers do not mark regeneration complete from an old video URL', async () => {
  const h = videoHarness()
  const { shot, previous } = continuityShots(h)
  previous.video_prompt = '镜头向前推进'
  await h.usePreviousVideoFrame(shot)
  h.taskListing.tasks = [{ id: 11, type: 'video', storyboard_id: previous.id, status: 'processing' }]
  h.context.refresh = h.loadGenTasks
  h.openBatchVideoConfirm([previous])
  h.confirmBatchVideos()
  const batchCheck = h.watchChecks[0]
  assert.equal(typeof batchCheck, 'function')
  assert.equal(batchCheck(), false)
  assert.equal(h.context.pendingVideoIds.value.includes(previous.id), true)
  await h.loadGenTasks()
  assert.equal(batchCheck(), false)
  assert.equal(h.context.pendingVideoIds.value.includes(previous.id), true)

  const fallbackPoll = runInNewContext(`${pageFunction('hasProcessingVideoTask')}\n${pageFunction('pollVideoGeneration')}\n;pollVideoGeneration`, {
    ...h.context, hasProcessingVideoTask: h.hasProcessingVideoTask,
  })
  await fallbackPoll(undefined, previous.id, previous.video_url)
  assert.equal(h.watchChecks[1](), false)
  assert.equal(h.context.pendingVideoIds.value.includes(previous.id), true)
  await h.genVid(shot)
  assert.equal(h.requests.length, 1)
  assert.match(h.errors.at(-1), /上一分镜的视频或顺序已变化/)

  h.taskListing.tasks[0].status = 'completed'
  previous.video_url = 'static/videos/shot1-new.mp4'
  await h.loadGenTasks()
  assert.equal(h.isPendingVideo(previous.id), false)
  assert.equal(batchCheck(), true)
  assert.equal(h.watchChecks[1](), true)
})
