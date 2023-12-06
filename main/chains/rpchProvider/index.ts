import RPChSDK, { type Ops } from '@rpch/sdk'
import { isError } from '@rpch/sdk/build/jrpc'
import EventEmitter from 'events'
import { Connection } from 'ethereum-provider/dist/types'
import { v4 as uuid } from 'uuid'
import provider from 'eth-provider'
import store from '../../store'
import log from 'electron-log'

// @ts-ignore
import ProviderCreator from 'eth-provider/provider'

const dev = process.env.NODE_ENV === 'development'

class RPChSDKSingleton {
  static sdk: RPChSDK | undefined

  static options: Ops = {
    discoveryPlatformEndpoint: process.env.DISCOVERY_PLATFORM_API_ENDPOINT || undefined,
    forceZeroHop: true,

    // TODO: Remove after confirmation and testing
    debugScope: 'rpch:*'
  }

  static send(...args: Parameters<RPChSDK['send']>): ReturnType<RPChSDK['send']> {
    if (!this.sdk) {
      // TODO: Remove after confirmation and testing
      log.info('RPCh: Client ID ', process.env.RPCH_SECRET_TOKEN)

      if (!process.env.RPCH_SECRET_TOKEN) {
        log.error('MISSING RPCH SECRET TOKEN')
        throw new Error('MISSING RPCH SECRET TOKEN')
      }

      log.info('RPCh: first SEND request, creating SDK instance')
      this.sdk = new RPChSDK(process.env.RPCH_SECRET_TOKEN, this.options)
    }
    return this.sdk.send(...args)
  }
}

class RPChConnection extends EventEmitter implements Connection {
  private rpcUrl: string
  private connected: boolean
  private closed: boolean
  private subscriptions: boolean
  private status: string
  private pollId: string
  private subscriptionTimeout: NodeJS.Timeout | undefined

  constructor(rpcUrl: string) {
    super()

    this.rpcUrl = rpcUrl
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
    if (!this.closed && this.listenerCount('error')) {
      log.error(err)
      this.emit('error', err)
    }
  }

  create() {
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
    if (dev) log.info('Closing HTTP connection')

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
    log.info('RPCH send', payload)
    if (this.closed) return this.error(payload, 'Not connected')
    if (payload.method === 'eth_subscribe') {
      if (this.subscriptions) {
        payload.pollId = this.pollId
      } else {
        return this.error(payload, 'Subscriptions are not supported by this HTTP endpoint')
      }
    }

    const { id, jsonrpc } = payload

    return RPChSDKSingleton.send(payload, { provider: this.rpcUrl })
      .then((res) => {
        return res.json()
      })
      .then((jsonRes) => {
        log.info(
          '====================================================================================================='
        )
        log.info('RPCH send', jsonRes)

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
        this._emit('payload', result)
      })
      .catch((err) => {
        log.info('RPCH send error', err, payload)
        if (internal) {
          internal(err)
          return
        }
        const load = { id, jsonrpc, error: { message: err.message, code: err.code } }
        this._emit('payload', load)
      })
  }
}

export const createRpchProvider: typeof provider = (target, options = {}) => {
  const isRpchEnabled = store('main.rpchEnabled')
  log.info(`RPCh ${isRpchEnabled ? 'enabled' : 'disabled'}`)

  if (typeof target === 'string' && /^http(s)?:\/\//i.test(target) && isRpchEnabled) {
    return ProviderCreator(
      {
        http: (rpcUrl: string) => new RPChConnection(rpcUrl),
        injected: { __isProvide: false }
      },
      [{ type: 'custom', location: target, protocol: 'http' }],
      options
    )
  }
  return provider(target, options)
}
