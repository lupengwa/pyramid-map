const port = Number(process.argv[2])
if (!Number.isInteger(port)) throw new Error("stale server fixture requires PORT")

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (new URL(request.url).pathname === "/healthz") {
      return Response.json({
        ok: true,
        app: "pyramid-map",
        pid: process.pid,
      })
    }
    return new Response("stale")
  },
})

console.log(`stale:${server.port}`)
