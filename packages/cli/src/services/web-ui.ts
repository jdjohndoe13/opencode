import { FSUtil } from "@opencode/util/fs-util"
import { RequestSite } from "@opencode/server/request-site"
import { Effect, FileSystem, Option } from "effect"
import { Headers, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { load, type AssetMap, type BrotliMap } from "../app-assets"

/** Normalize a configured base path to a leading-slash, no-trailing-slash prefix, or `""` for the root. */
export function normalizeBasePath(input: string | undefined) {
  const trimmed = (input ?? "").trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function isApiPath(pathname: string) {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/openapi.json"
}

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: {
  readonly assets?: AssetMap
  readonly brotli?: BrotliMap
  readonly basePath?: string
  readonly cors?: ReadonlyArray<string>
}) {
  const basePath = normalizeBasePath(options?.basePath)
  const cors = options?.cors
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed({ files: options.assets, brotli: options.brotli })
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      // Under a base path the prefix is authoritative for the UI: paths outside it are not served, and the API and
      // asset handling below run on the stripped path. The API stays reachable at the root too, because local
      // clients (the service registration, `opencode run`) always talk to the bare origin.
      let pathname = url.pathname
      let req = request
      if (basePath !== "") {
        if (pathname === basePath) pathname = "/"
        else if (pathname.startsWith(`${basePath}/`)) pathname = pathname.slice(basePath.length)
        else if (!isApiPath(pathname)) return HttpServerResponse.empty({ status: 404 })
        if (pathname !== url.pathname) {
          // A doubled slash after the prefix would leave `//…`, which URL parsing reads as a different host.
          req = request.modify({ url: pathname.replace(/^\/+/, "/") + url.search })
          // The server's own cross-site guard runs before this transform and sees the prefixed path, so re-check
          // the stripped request here to keep the API guard authoritative under a base path.
          if (RequestSite.rejected(req, { cors }))
            return HttpServerResponse.jsonUnsafe(
              { _tag: "ForbiddenError", message: "Cross-site requests to the API are not allowed" },
              { status: 403 },
            )
        }
      }
      // Serve the web shell before API authentication so a signed-out browser gets the app's sign-in screen.
      if (isApiPath(pathname))
        return yield* api.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, req),
          Effect.map((response) => (basePath === "" ? response : prefixLocation(response, basePath))),
          Effect.catchIf(isRouteNotFound, () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
        )
      return yield* assets.pipe(Effect.flatMap((loaded) => serveUI(req, pathname, loaded.files, loaded.brotli, basePath)))
    })
})

// The API routes never learn about the prefix, so a root-relative redirect they answer (the pairing link's
// redirect to the app root) would leave the prefix. Prefix it so the browser lands back on the mounted UI.
function prefixLocation(response: HttpServerResponse.HttpServerResponse, basePath: string) {
  if (response.status < 300 || response.status >= 400) return response
  const location = Option.getOrUndefined(Headers.get(response.headers, "location"))
  if (location === undefined || !location.startsWith("/") || location.startsWith("//") || location.startsWith(basePath))
    return response
  return HttpServerResponse.setHeader(response, "location", basePath + location)
}

function serveUI(
  request: HttpServerRequest.HttpServerRequest,
  pathname: string,
  assets: AssetMap,
  brotli: BrotliMap | undefined,
  basePath: string,
) {
  const key = pathname.replace(/^\//, "")
  // A browser that takes brotli gets the embedded bytes as they are, so the server decompresses nothing. The HTML stays
  // decoded, because its CSP hashes the inline theme script.
  const encoded = key !== "index.html" && acceptsBrotli(request.headers["accept-encoding"]) ? brotli?.[key] : undefined
  const requested = encoded ?? assets[key]
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && requested === undefined)
    return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }))
  const name = requested !== undefined ? key : "index.html"
  let file = requested ?? assets["index.html"]
  if (file === undefined) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
  if (request.method !== "GET" && request.method !== "HEAD")
    return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const html = name === "index.html"
  // Under a base path the built HTML references its files from the root, so the served copy is rewritten to the
  // prefix and told the app where it is mounted. The default mode (no base path) serves the bytes untouched.
  const baseScript = html && basePath !== "" ? baseScriptFor(basePath) : undefined
  if (baseScript !== undefined) file = rewriteHtml(text(file), basePath, baseScript.tag)
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html
      ? cspForHtml(text(file), baseScript === undefined ? undefined : hash(baseScript.body))
      : csp(),
    "x-content-type-options": "nosniff",
    ...(!html && brotli?.[name] !== undefined ? { vary: "accept-encoding" } : {}),
    ...(encoded ? { "content-encoding": "br" } : {}),
  }
  return Effect.succeed(
    request.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.raw(file, { headers, contentType: headers["content-type"] }),
  )
}

// The exact contract between the server transform and the app: the UI reads this global to prefix its API base URL
// and its router base. The value is the normalized base path the server was configured with.
function baseScriptFor(basePath: string) {
  const body = `window.__OPENCODE_BASE__="${basePath}";`
  return { body, tag: `<script>${body}</script>` }
}

function rewriteHtml(html: string, basePath: string, baseScript: string) {
  return html
    .replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${baseScript}`)
    .replace(/(src|href)="\/(?!\/)/g, (_match, attr: string) => `${attr}="${basePath}/`)
    .replace(/url\(\/(?!\/)/g, () => `url(${basePath}/`)
}

function text(file: string | Uint8Array) {
  return typeof file === "string" ? file : Buffer.from(file).toString()
}

function hash(body: string) {
  return createHash("sha256").update(body).digest("base64")
}

function acceptsBrotli(header: string | undefined) {
  return (header ?? "").split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase())
    return parts[0] === "br" && !parts.slice(1).some((part) => /^q=0(?:\.0*)?$/.test(part))
  })
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

// qr-scanner decodes in a worker it creates from a blob: URL whenever the browser has no BarcodeDetector (Safari, desktop
// Chrome on Windows and Linux). Without worker-src that worker falls under script-src 'self' and never starts.
// Artifact previews render HTML and PDF files from blob: URLs; without frame-src and object-src they fall back to
// default-src 'self' and are blocked.
function csp(hashes: string | ReadonlyArray<string> = "") {
  const list = (typeof hashes === "string" ? [hashes] : [...hashes]).filter((entry) => entry !== "")
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${list.map((entry) => ` 'sha256-${entry}'`).join("")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'self' blob:`
}

function cspForHtml(body: string, extraHash?: string) {
  const match = body.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )
  return csp([match ? hash(match[2]) : "", extraHash ?? ""].filter((entry) => entry !== ""))
}

export * as WebUi from "./web-ui"
