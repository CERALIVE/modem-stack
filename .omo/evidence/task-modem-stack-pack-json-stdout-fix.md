# npm pack JSON stdout fix

## Root cause

`npm pack ./control --json > pack.json` redirects the parent shell's stdout for
the entire command, including the `prepack` child process. `prepack` runs
`bun run build`, and `control/scripts/build.ts` wrote its informational
`built 7 public entries into dist/` message with `console.log`. That message
was therefore prepended to npm's JSON array and made `pack.json` unparsable.

The build message is progress information, not a machine-readable result. It
now uses `console.error`, leaving stdout available for JSON-producing callers.

## Before

Command, from the repository root:

```text
$ npm pack ./control --json > /tmp/pack-test-before.json 2>/tmp/pack-test-before.stderr
$ node -p "require('/tmp/pack-test-before.json')[0].filename"
SyntaxError: /tmp/pack-test-before.json: Unexpected token 'b', "built 7 pu"... is not valid JSON
```

The captured stdout began:

```text
built 7 public entries into dist/
[
  {
```

The command itself exited 0; the subsequent JSON consumer failed, matching the
release workflow failure.

## Fix and after

`control/scripts/build.ts` line 150 changed from `console.log(...)` to
`console.error(...)`. A complete search of `control/scripts/build.ts` found no
other `console.log` calls. The neighboring tarball and consumer scripts use
their logs as human-facing CLI output and do not produce the npm JSON stream.

```text
$ npm pack ./control --json > /tmp/pack-test-after.json 2>/tmp/pack-test-after.stderr
$ node -p "require('/tmp/pack-test-after.json')[0].filename"
ceralive-modem-control-1.1.0.tgz
$ node -p "require('/tmp/pack-test-after.json')[0].integrity"
sha512-8Q7Qa0fFS8d42C0xcaWlOGswwE/3fuMk8+PHXCfED9DOhCP3LRPmrvdIyK47NUNaLZEcffN2z/BVTOekILAVfA==
```

After the fix, the JSON file starts with `[` and the build progress line is in
`/tmp/pack-test-after.stderr`.
