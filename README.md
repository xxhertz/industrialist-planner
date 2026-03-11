# industrialist-planner

industrialist-planner is a typescript terminal app for defining production items and recipes, then calculating the smallest whole-machine factory chain needed to sustain a target output.

## description

industrialist tui production planner for building recipe catalogs and calculating full-efficiency machine chains

## screenshot

![screenshot of the program](https://i.imgur.com/Aq9PHS3.png)

## features

- terminal interface built with blessed
- editable catalog of items and recipes stored in `data/catalog.json`
- planning by machine count or target output per second
- automatic scaling to whole-machine counts
- support for alternate recipe selection when multiple producers exist
- cycle detection and catalog validation

## tech stack

- typescript
- node.js
- blessed
- vitest

## getting started

```bash
npm install
npm run dev
```

## available scripts

```bash
npm run dev
npm run build
npm start
npm test
```

## project structure

```text
src/
  core/     planning, rational math, catalog, storage, types
  tui/      terminal ui
  index.ts  app entrypoint
data/
  catalog.json
test/
  planner and rational tests
```

## how it works

1. create items and recipes in the catalog screen
2. choose a target recipe in the planner
3. plan by machine count or output rate
4. review scaled machine counts, external inputs, and the dependency tree

## license

isc
