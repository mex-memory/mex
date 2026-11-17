# Third-party notices

MEX builds its TypeScript and JavaScript code graph with two compilers that it
installs as npm dependencies. Both are licensed under the Apache License,
Version 2.0. Their packages, installed next to MEX, carry their full `LICENSE`
and `NOTICE.txt` files.

## TypeScript

- Package: `typescript` (installed as `typescript-7`), version pinned in `package.json`.
- Copyright (c) Microsoft Corporation.
- Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0
- Source: https://github.com/microsoft/TypeScript

## tsrs

- Package: `tsrs`, version pinned in `package.json`.
- Copyright 2026 Max Schwenk and the tsrs contributors.
- tsrs is a Rust port of the TypeScript 7 type checker. It is a derivative work of
  TypeScript, Copyright (c) Microsoft Corporation, licensed under the Apache
  License, Version 2.0. The tsrs binary embeds TypeScript's `lib.*.d.ts` files.
- Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0
- Source: https://github.com/oxc-project/tsrs

TypeScript's notices for the third-party material it incorporates are reproduced
unchanged in the `NOTICE.txt` of each package above.
