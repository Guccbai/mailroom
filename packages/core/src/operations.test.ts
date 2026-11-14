import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeOperation,
  listOperations,
  parseOperationInput,
} from './operations.js'

test('operation discovery is compact and sorted', () => {
  const operations = listOperations()
  assert.ok(operations.length >= 20)
  assert.deepEqual(
    operations.map((item) => item.id),
    operations.map((item) => item.id).sort(),
  )
  const first = operations[0]
  assert.ok(first)
  assert.equal('inputSchema' in first, false)
})

test('describe exposes one JSON schema', () => {
  const description = describeOperation('messages.get')
  assert.equal(description.id, 'messages.get')
  assert.equal(description.inputSchema.type, 'object')
})

test('every operation exposes a JSON schema', () => {
  for (const operation of listOperations()) {
    const description = describeOperation(operation.id)
    assert.equal(description.id, operation.id)
    assert.equal(description.inputSchema.type, 'object')
  }
})

test('operation input applies defaults and rejects invalid values', () => {
  assert.deepEqual(parseOperationInput('messages.list', {}), { limit: 25 })
  assert.deepEqual(
    parseOperationInput('domains.upsert', { domain: 'EXAMPLE.COM' }),
    {
      domain: 'example.com',
      enabled: true,
    },
  )
  assert.throws(
    () => parseOperationInput('messages.get', { id: '' }),
    /Invalid operation parameters/,
  )
})

test('compose requires a sender and validates attachments', () => {
  assert.throws(
    () =>
      parseOperationInput('drafts.compose', {
        to: ['a@example.com'],
        subject: 'Hi',
        text: 'Hello',
      }),
    /Invalid operation parameters/,
  )
  const parsed = parseOperationInput('drafts.compose', {
    from: 'Me@Example.com',
    to: ['A@example.com'],
    subject: 'Hi',
    text: 'Hello',
    attachments: [{ filename: 'a.txt', contentBase64: 'aGk=' }],
  })
  assert.equal(parsed.from, 'me@example.com')
  assert.deepEqual(parsed.to, ['a@example.com'])
  assert.deepEqual(parsed.attachments, [
    {
      filename: 'a.txt',
      contentType: 'application/octet-stream',
      contentBase64: 'aGk=',
    },
  ])
  for (const attachment of [
    { filename: 'a/b.txt', contentBase64: 'aGk=' },
    { filename: 'a.txt', contentBase64: 'aGk' },
    { filename: 'a.txt', contentType: 'not a type', contentBase64: 'aGk=' },
  ]) {
    assert.throws(
      () =>
        parseOperationInput('drafts.compose', {
          from: 'me@example.com',
          to: ['a@example.com'],
          subject: 'Hi',
          text: 'Hello',
          attachments: [attachment],
        }),
      /Invalid operation parameters/,
    )
  }
})

test('new categories are discoverable', () => {
  const ids = listOperations().map((item) => item.id)
  for (const id of [
    'attachments.get',
    'drafts.compose',
    'notifications.status',
    'notifications.test',
  ]) {
    assert.ok(ids.includes(id), id)
  }
})
