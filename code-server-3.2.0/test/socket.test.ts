import { field, logger } from "@coder/logger"
import * as assert from "assert"
import * as fs from "fs-extra"
import "leaked-handles"
import * as net from "net"
import * as path from "path"
import * as tls from "tls"
import { Emitter } from "../src/common/emitter"
import { generateCertificate, tmpdir } from "../src/node/util"
import { SocketProxyProvider } from "../src/node/socket"

describe("SocketProxyProvider", () => {
  const provider = new SocketProxyProvider()

  const onServerError = new Emitter<{ event: string; error: Error }>()
  const onClientError = new Emitter<{ event: string; error: Error }>()
  const onProxyError = new Emitter<{ event: string; error: Error }>()
  const fromServerToClient = new Emitter<string>()
  const fromClientToServer = new Emitter<string>()
  const fromClientToProxy = new Emitter<Buffer>()

  let errors = 0
  let close = false
  const onError = ({ event, error }: { event: string; error: Error }): void => {
    if (!close || event === "error") {
      logger.error(event, field("error", error.message))
      ++errors
    }
  }
  onServerError.event(onError)
  onClientError.event(onError)
  onProxyError.event(onError)

  let server: tls.TLSSocket
  let proxy: net.Socket
  let client: tls.TLSSocket

  const getData = <T>(emitter: Emitter<T>): Promise<T> => {
    return new Promise((resolve) => {
      const d = emitter.event((t) => {
        d.dispose()
        resolve(t)
      })
    })
  }

  before(async () => {
    const cert = await generateCertificate()
    const options = {
      cert: fs.readFileSync(cert.cert),
      key: fs.readFileSync(cert.certKey),
      rejectUnauthorized: false,
    }

    await fs.mkdirp(path.join(tmpdir, "tests"))
    const socketPath = await provider.findFreeSocketPath(path.join(tmpdir, "tests/tls-socket-proxy"))
    await fs.remove(socketPath)

    return new Promise((_resolve) => {
      const resolved: { [key: string]: boolean } = { client: false, server: false }
      const resolve = (type: "client" | "server"): void => {
        resolved[type] = true
        if (resolved.client && resolved.server) {
          // We don't need any more connections.
          main.close() // eslint-disable-line @typescript-eslint/no-use-before-define
          _resolve()
        }
      }
      const main = tls
        .createServer(options, (s) => {
          server = s
          server
            .on("data", (d) => fromClientToServer.emit(d))
            .on("error", (error) => onServerError.emit({ event: "error", error }))
            .on("end", () => onServerError.emit({ event: "end", error: new Error("unexpected end") }))
            .on("close", () => onServerError.emit({ event: "close", error: new Error("unexpected close") }))
          resolve("server")
        })
        .on("error", (error) => onServerError.emit({ event: "error", error }))
        .on("end", () => onServerError.emit({ event: "end", error: new Error("unexpected end") }))
        .on("close", () => onServerError.emit({ event: "close", error: new Error("unexpected close") }))
        .listen(socketPath, () => {
          client = tls
            .connect({ ...options, path: socketPath })
            .on("data", (d) => fromServerToClient.emit(d))
            .on("error", (error) => onClientError.emit({ event: "error", error }))
            .on("end", () => onClientError.emit({ event: "end", error: new Error("unexpected end") }))
            .on("close", () => onClientError.emit({ event: "close", error: new Error("unexpected close") }))
            .once("connect", () => resolve("client"))
        })
    })
  })

  it("should work without a proxy", async () => {
    server.write("server->client")
    assert.equal(await getData(fromServerToClient), "server->client")
    client.write("client->server")
    assert.equal(await getData(fromClientToServer), "client->server")
    assert.equal(errors, 0)
  })

  it("should work with a proxy", async () => {
    assert.equal(server instanceof tls.TLSSocket, true)
    proxy = (await provider.createProxy(server))
      .on("data", (d) => fromClientToProxy.emit(d))
      .on("error", (error) => onProxyError.emit({ event: "error", error }))
      .on("end", () => onProxyError.emit({ event: "end", error: new Error("unexpected end") }))
      .on("close", () => onProxyError.emit({ event: "close", error: new Error("unexpected close") }))

    provider.stop() // We don't need more proxies.

    proxy.write("server proxy->client")
    assert.equal(await getData(fromServerToClient), "server proxy->client")
    client.write("client->server proxy")
    assert.equal(await getData(fromClientToProxy), "client->server proxy")
    assert.equal(errors, 0)
  })

  it("should close", async () => {
    close = true
    client.end()
    proxy.end()
  })
})
