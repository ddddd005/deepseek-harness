import { clientBundle } from '../../client/tsdown.client.ts'

/** Bundle only the private browser management surface. */
export default clientBundle('@deepseek-ai/dsh-prompt-control-ui', ['lib/types/index.js'])
