import { describe, expect, it } from 'vitest'
import { buildApns } from '../src/fcm/client.js'

describe('buildApns', () => {
  it('turns the data payload into an iOS alert', () => {
    const apns = buildApns({ mb_id: 'n1', mb_title: 'Paunovo oko', mb_body: 'Vrijeme je za zaštitu' })

    expect(apns.headers['apns-push-type']).toBe('alert')
    expect(apns.payload.aps.alert).toEqual({ title: 'Paunovo oko', body: 'Vrijeme je za zaštitu' })
    expect(apns.payload.aps.sound).toBe('default')
  })
})
