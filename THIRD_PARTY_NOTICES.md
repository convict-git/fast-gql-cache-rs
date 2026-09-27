# Third-party notices

## Apollo Client

Parts of this repository are adapted from [Apollo Client](https://github.com/apollographql/apollo-client)
(`@apollo/client@4.2.11`) and remain under its MIT license, reproduced below:

- `src/InMemoryCacheRs.ts` and `src/InMemoryCacheRsConfig.ts`, which carry over
  `InMemoryCache`'s implementation and configuration types, and the published `dist/` built
  from them;
- the test suites in `src/__tests__/`, ported from Apollo's own (`src/__tests__/README.md`
  maps each file to its source);
- `patches/@apollo+client+4.2.11.patch`;
- excerpts of Apollo Client's source quoted in the documentation.

```text
The MIT License (MIT)

Copyright (c) 2022 Apollo Graph, Inc. (Formerly Meteor Development Group, Inc.)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## Logos

The logos in the README's title are the marks of their owners and are not covered by
this repository's licenses. They live on the
[`dnd-data/assets`](https://github.com/convict-git/fast-gql-cache-rs/tree/dnd-data/assets#logos) branch, which lists each file's
source and terms.
