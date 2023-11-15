import RPChSDK, { JRPC, type Ops } from '@rpch/sdk'
import EventEmitter from 'events'
import { Connection } from 'ethereum-provider/dist/types'
import { isError, Result } from '@rpch/sdk/build/jrpc'
import { Response } from '@rpch/sdk/build/response'
import { v4 as uuid } from 'uuid'
import EthereumProvider from 'ethereum-provider'
import provider from 'eth-provider'

const dev = process.env.NODE_ENV === 'development'

class RPChConnection extends EventEmitter implements Connection {
  private sdk: RPChSDK

  private connected: boolean
  private closed: boolean
  private subscriptions: boolean
  private status: string
  private pollId: string
  private subscriptionTimeout: NodeJS.Timeout | undefined

  constructor(options: Ops = {}) {
    super()

    // TODO: Remove after confirmation and testing
    console.log('RPCh: CREATING SDK INSTANCE with OPS ', options)
    console.log('RPCh: Client ID ', process.env.VUE_APP_RPCH_SECRET_TOKEN)
    this.sdk = new RPChSDK(process.env.RPCH_SECRET_TOKEN || '', {
      discoveryPlatformEndpoint: process.env.DISCOVERY_PLATFORM_API_ENDPOINT || undefined,
      ...options // priority for "options" object
    })

    this.connected = false
    this.closed = false
    this.subscriptions = false
    this.status = 'loading'
    this.pollId = uuid()

    this.subscriptionTimeout = undefined
    setTimeout(() => this.create(), 0)
  }

  _emit(...args: any[]) {
    // @ts-ignore
    return !this.closed ? this.emit(...args) : null
  }

  onError(err: Error) {
    if (!this.closed && this.listenerCount('error')) this.emit('error', err)
  }

  create() {
    if (!this.sdk) return this.onError(new Error('No RPCh instance available'))
    this.on('error', () => {
      if (this.connected) this.close()
    })
    this.init()
  }

  init() {
    this.send({ jsonrpc: '2.0', method: 'net_version', params: [], id: 1 }, (err) => {
      if (err) return this.onError(err)
      this.connected = true
      this._emit('connect')
      this.send(
        { jsonrpc: '2.0', id: 1, method: 'eth_pollSubscriptions', params: [this.pollId, 'immediate'] },
        (err) => {
          if (!err) {
            this.subscriptions = true
            this.pollSubscriptions()
          }
        }
      )
    })
  }

  pollSubscriptions() {
    this.send(
      { jsonrpc: '2.0', id: 1, method: 'eth_pollSubscriptions', params: [this.pollId] },
      (err, result: unknown) => {
        if (err) {
          this.subscriptionTimeout = setTimeout(() => this.pollSubscriptions(), 10000)
          return this.onError(err)
        } else {
          if (!this.closed) {
            this.subscriptionTimeout = undefined
            this.pollSubscriptions()
          }
          if (result) {
            ;(result as string[])
              .map((p) => {
                let parse
                try {
                  parse = JSON.parse(p)
                } catch (e) {
                  parse = false
                }
                return parse
              })
              .filter((n) => n)
              .forEach((p) => this._emit('payload', p))
          }
        }
      }
    )
  }

  close() {
    if (dev) console.log('Closing HTTP connection')

    clearTimeout(this.subscriptionTimeout)

    this._emit('close')
    this.closed = true
    this.removeAllListeners()
  }

  // TODO: Check if used
  // filterStatus(res: Response) {
  //   if (res.status >= 200 && res.status < 300) return res
  //   const error = new Error(res.statusText)
  //   error.res = res
  //   throw error.message
  // }

  error(payload: JSONRPCRequestPayload, message: string, code = -1) {
    this._emit('payload', { id: payload.id, jsonrpc: payload.jsonrpc, error: { message, code } })
    return Promise.reject()
  }

  send(
    payload: JSONRPCRequestPayload & { pollId?: string },
    internal?: (err: Error | null, result?: unknown) => void
  ) {
    if (this.closed) return this.error(payload, 'Not connected')
    if (payload.method === 'eth_subscribe') {
      if (this.subscriptions) {
        payload.pollId = this.pollId
      } else {
        return this.error(payload, 'Subscriptions are not supported by this HTTP endpoint')
      }
    }

    const { id, jsonrpc } = payload

    return this.sdk
      .send(payload)
      .then((res: Response) => {
        return res.json()
      })
      .then((jsonRes: JRPC.Response): Result => {
        if (isError(jsonRes)) {
          throw jsonRes
        }
        return jsonRes
      })
      .then((result) => {
        if (internal) {
          internal(null, result)
          return
        }
        const load = { id, jsonrpc, result }
        this._emit('payload', load)
      })
      .catch((err) => {
        if (internal) {
          internal(err)
          return
        }
        const load = { id, jsonrpc, error: { message: err.message, code: err.code } }
        this._emit('payload', load)
      })
  }
}

export const createRpchProvider: typeof provider = (target, options) => {
  if (typeof target === 'string' && /^http(s)?:\/\//i.test(target)) {
    return new EthereumProvider(new RPChConnection())
  }
  return provider(target, options)
}
