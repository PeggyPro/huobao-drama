import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { COMFYUI_WORKFLOWS } from '../services/adapters/comfyui.js'

const app = new Hono()

// GET /comfyui/workflows — canonical Huobao model-to-workflow mappings
app.get('/workflows', (c) => success(c, Object.values(COMFYUI_WORKFLOWS)))

export default app
