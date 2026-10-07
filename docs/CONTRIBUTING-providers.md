# Contributing a provider

A provider adds support for one cloud: its resource types, how they nest in the
diagram, read-only CLI commands to inspect them, console links, and how to read
their rule lists. A provider consists of a folder, `src/ts/providers/<name>/`,
and one entry in `src/ts/providers/index.ts`. No other file needs to change.

`docs/DEVELOPMENT.md#providers` lists the fields of a `ProviderPlugin`.
`src/ts/providers/gcp/` is a small, complete example. For placement, the SDK
functions `referencedValues` and `singleReferencedValue` find which of the
provider's boxes a resource's references point to, including `count` instances
and `[*]` splat references.

## What a provider returns

A provider returns data. Core converts the data to HTML, command lines and
links, and validates it first.

| The provider returns | Core |
| --- | --- |
| A catalog: labels, icons, categories, scopes (plain data) | Draws the tiles, escaping every string |
| Boxes, added with `api.addContainer`, and the box for each resource | Validates each call, builds the layout |
| Commands as argument lists: `["gcloud", "compute", "instances", "describe", name]` | Quotes each argument for POSIX sh, bash and zsh |
| Console URLs, on the hosts listed in `consoleHosts` (`{host: "console.aws.amazon.com", allowRegionPrefix: true}`) | Returns a link only if links are turned on and the URL is https on one of those hosts |
| Rule lists, as plain-text fields (`rules.describe`) | Draws the rule tables, diff rows and hover cards |

Every hook receives a `ProviderResource`: a frozen copy of the fields a provider
may read, with sensitive values already replaced by `(sensitive value)`. Values
have the type `JsonValue`; read them with the SDK functions `asText`, `valueAt`
and `asList`, for example `asText(valueAt(r.attrs, "tags", "Name"))`. Hooks do
not receive other providers' resources or core's own objects, and provider
files may not reference the DOM (see below).

Core calls the `cli`, `consoleUrl`, `tileSubtitle`, `sizing` and `rules` hooks
through `core/hooks.ts`. If a hook throws, or returns a value that fails
validation, core uses a neutral result for that call (no commands, no link, the
unformatted value) and adds an error diagnostic to the plan. If placement
throws or makes an invalid call, core discards the provider's boxes and draws
each of its resources as a tile, so every visible resource still appears in the
diagram.

`settingKeys` lists the provider-block arguments the hooks receive, for
settings a diagram needs (region, project, zone). Registration refuses a key
whose name suggests a credential (`token`, `secret_key`, `password`, ...), and a
value that comes from a variable declared `sensitive` is not passed.

## What a provider may not use

`just test-providers`, part of `just test`, `npm test` and the Test workflow,
fails if a file in a provider folder:

- imports anything other than `../../sdk/index.js` and files in its own folder
- references or declares `document`, `window`, `globalThis`, `fetch`,
  `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`,
  `indexedDB`, `setTimeout`, `setInterval`, `eval`, `Function`, `Reflect`,
  `Proxy` or `require`, or uses `import()` (the full list is `BANNED_GLOBALS`
  in `tools/check-providers.js`)
- uses the properties `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `constructor`, `__proto__` or `prototype`
- contains `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `declare` or `with`

It also fails if code outside the provider folders contains a string or regular
expression that holds a registered provider's type prefix or equals its id or a
local name (`"aws_vpc"`, `/^google_/`, `"aws"`). Provider-specific behaviour
belongs in the provider's folder.

Return plain values. Do not build HTML or shell command strings: core escapes
values for HTML and quotes command arguments.

## Icons

A catalog entry's `icon` is either a shared symbol from `src/index.html`
(`i-vpc`, `i-ec2`, `i-s3`, ...) or a key of the plugin's `icons`:

```ts
icons: {
  "cloud-sql": { grid: 64, paths: ["M12 10 L52 10 L52 54 L12 54 Z", "M20 20 h24 v4 h-24 z"] }
},
catalog: {
  google_sql_database_instance: { kind: "node", label: "Cloud SQL", icon: "cloud-sql", cat: "db" }
}
```

The provider supplies only the glyph, as SVG path data on a 48- or 64-unit
grid. Core creates the SVG elements: a rounded tile filled with the category
colour, as for the built-in icons, with the glyph in white. Path data may
contain only path command letters, digits, signs, decimal points, exponents,
commas and whitespace; registration refuses anything else, including markup,
`url(...)` and CSS. Icon keys are lower-case words and may not start with `i-`.
Draw original glyphs; do not copy a vendor's logo unless its licence allows it.

## Before opening a pull request

```sh
just test          # types, build, unit tests, CSP and provider checks, baselines
```

- Once the provider is registered in `src/ts/providers/index.ts`, the contract
  suite in `tools/test.js` ("providers: contract") tests it, including with a
  plan that has hostile values in every attribute.
- If possible, add a small sample plan under `samples/`: real
  `terraform show -json` output, with account IDs and secrets removed.
- If a baseline in `tools/baseline/` changed, explain why in the pull request.

## For reviewers

A provider-only pull request changes files in `src/ts/providers/<name>/` and one
line of `src/ts/providers/index.ts`. Check:

1. **The diff is limited to the provider.** A change under `src/ts/core/`,
   `src/ts/sdk/`, `src/ts/types/`, `src/ts/ui/`, `scripts/`, `tools/`,
   `package*.json` or `.github/` is a core change and needs a maintainer's
   review.
2. **`consoleHosts`.** Registration accepts only plain hostnames; check that
   they are the cloud's own console domains.
3. **Commands.** Only read-only operations (`describe`, `get`, `list`). A
   command that changes infrastructure does not belong in a provider.
4. **Cloud correctness**: labels, nesting, rule semantics. The automated
   checks do not cover these.

The checks restrict what provider code uses; they do not isolate it at
runtime. Merged provider code runs in the page with the same privileges as the
rest of the app.

## For maintainers

While one person has write access, every change to `main` is pushed or merged
by that person. One setting is useful now, under Settings → Branches (or Rules)
for `main`:

- require the `Test / test` status check (`.github/workflows/test.yml`, which
  runs on every pull request) to pass before merging

When more people have write access, add a `.github/CODEOWNERS` file naming the
maintainers for everything outside `src/ts/providers/<name>/` (`core/`, `sdk/`,
`types/`, `ui/`, `app.ts`, `main.ts`, `providers/index.ts`, `index.html`,
`scripts/`, `tools/`, `package*.json`, `.github/`, `cli/`), with no owner for
provider folders, and require a pull request with review from code owners.
With a single maintainer, CODEOWNERS would only request that maintainer's own
review.
