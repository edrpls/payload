import type { Payload } from 'payload'

import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadInt } from '../__helpers/shared/initPayloadInt.js'
import { closeSink, putRequests } from './s3-sink.js'

let payload: Payload

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/**
 * Reproduction: sequential Local API creates on an upload collection that
 * REUSE ONE `context` object (the common seed/import-script pattern) upload
 * only the FIRST file's binary. Every later create still returns a fully
 * populated document — but the adapter never issues a PutObject for it.
 *
 * Mechanism (traced in plugin-cloud-storage):
 *   1. `createLocalReq`'s `getRequestContext` hands the caller's `context`
 *      object to `req.context` BY REFERENCE.
 *   2. The plugin's afterChange hook sets `req.context.skipCloudStorage = true`
 *      (mutating the caller's object) before its internal metadata update.
 *   3. Inside that nested update, `createLocalReq` re-binds `req.context` to a
 *      shallow COPY, so the hook's `finally { delete req.context.skipCloudStorage }`
 *      deletes the flag from the copy — the caller's object keeps it forever.
 *   4. Every subsequent create sharing the object hits the hook's
 *      `skipCloudStorage` early-return and silently skips the upload.
 */
describe('plugin-cloud-storage — shared Local API context', () => {
  let fixtureDir: string

  const fixtures = ['shared-ctx-a.png', 'shared-ctx-b.png', 'shared-ctx-c.png']
  const controlFixtures = ['fresh-ctx-a.png', 'fresh-ctx-b.png', 'fresh-ctx-c.png']

  const uploaded = (name: string): boolean =>
    putRequests.some((key) => key === `/repro-bucket/${name}`)

  beforeAll(async () => {
    ;({ payload } = await initPayloadInt(dirname))

    // Distinctly-named copies of the standard fixture so every create maps to
    // its own object key.
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'shared-ctx-'))
    for (const name of [...fixtures, ...controlFixtures]) {
      await copyFile(path.resolve(dirname, '../uploads/image.png'), path.join(fixtureDir, name))
    }
  })

  afterAll(async () => {
    await payload.destroy()
    await closeSink()
    await rm(fixtureDir, { recursive: true, force: true })
  })

  it('uploads every file when sequential creates SHARE one context object', async () => {
    const sharedContext = { mySeedFlag: true }

    for (const name of fixtures) {
      const doc = await payload.create({
        collection: 'media',
        context: sharedContext,
        data: {},
        filePath: path.join(fixtureDir, name),
      })
      // The document row is always created and fully populated — that is what
      // makes the data loss silent.
      expect(doc.filename).toBe(name)
    }

    // The ORIGINAL of every file must have been PUT to storage. On the
    // current code this fails from the second file on: only shared-ctx-a.png
    // (and its sizes) ever reaches the bucket.
    for (const name of fixtures) {
      expect(uploaded(name), `original missing in bucket for ${name}`).toBe(true)
    }

    // The cause, observable directly: the plugin's recursion flag leaked onto
    // the caller's context object and never came off.
    expect(sharedContext).not.toHaveProperty('skipCloudStorage')
  })

  it('control: identical creates with a FRESH context object each all upload', async () => {
    for (const name of controlFixtures) {
      await payload.create({
        collection: 'media',
        context: { mySeedFlag: true },
        data: {},
        filePath: path.join(fixtureDir, name),
      })
    }

    for (const name of controlFixtures) {
      expect(uploaded(name), `original missing in bucket for ${name}`).toBe(true)
    }
  })
})
