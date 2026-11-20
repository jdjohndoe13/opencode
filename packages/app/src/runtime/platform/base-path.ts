/**
 * The path the app is served under, such as `/opencode`, without a trailing slash; empty at the root. The server's
 * `--base-path` transform injects `window.__OPENCODE_BASE__` before any script runs, which wins over the build-time
 * `BASE_URL` so one binary serves any prefix; a build made with `vite build --base=/x/` still works on its own.
 */
export const basePath = normalizeBasePath(
  (typeof window === "undefined" ? undefined : (window as { __OPENCODE_BASE__?: string }).__OPENCODE_BASE__) ??
    import.meta.env.BASE_URL,
)

export function normalizeBasePath(base: string | undefined) {
  const trimmed = (base ?? "").replace(/^\/+|\/+$/g, "")

  return trimmed ? `/${trimmed}` : ""
}

/** The browser path for an app path, such as `/opencode/new-session` for `/new-session`. */
export function withBasePath(path: string, base = basePath) {
  if (!base) return path

  return path === "/" ? `${base}/` : `${base}${path}`
}

/** The app path for a browser path, or the path itself when it lies outside the base. */
export function stripBasePath(path: string, base = basePath) {
  if (!base || !path.startsWith(base)) return path

  const rest = path.slice(base.length)

  if (rest.startsWith("/")) return rest

  if (rest === "" || rest.startsWith("?") || rest.startsWith("#")) return `/${rest}`

  return path
}
