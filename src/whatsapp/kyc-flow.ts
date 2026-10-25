import { createHash } from 'node:crypto';

/**
 * THE ID CHECK FORM (WhatsApp Flow), two short screens:
 *   1. WHY:    the "Why we check your ID" picture (Console → Chat pictures → Form: why we check your ID), and BVN or NIN
 *   2. NUMBER: the number and the date of birth, then "Check my ID"
 * The result (Verified) comes straight back in the chat. Static form: the answers arrive in the webhook; the chat blanks
 * that message once it's read, so the number is never kept. Changing anything here creates a new form on Meta.
 */
export function kycFlowJson(pictureBase64: string | null = null) {
  return {
    version: '7.3',
    screens: [
      {
        id: 'WHY',
        title: 'Quick ID check',
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...(pictureBase64 ? [{ type: 'Image', src: pictureBase64, height: 200, 'scale-type': 'contain', 'alt-text': 'Why we check your ID: once, by a licensed checker. We keep only the result, never your BVN or NIN.' }] : []),
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: 'Check your ID, once' },
                { type: 'TextBody', text: 'A licensed ID checker confirms it\'s really you. We keep only the result, never your BVN or NIN.' },
                { type: 'RadioButtonsGroup', name: 'method', label: 'Which one will you use?', required: true, 'data-source': [{ id: 'BVN', title: 'BVN' }, { id: 'NIN', title: 'NIN' }] },
                { type: 'TextCaption', text: '🔒 Hoolam never asks for your PIN, OTP or password.' },
                { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'NUMBER' }, payload: { method: '${form.method}' } } },
              ],
            },
          ],
        },
      },
      {
        id: 'NUMBER',
        title: 'Quick ID check',
        terminal: true,
        data: { method: { type: 'string', __example__: 'BVN' } },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextInput', name: 'number', label: 'The 11-digit number', 'input-type': 'number', required: true, 'min-chars': 11, 'max-chars': 11, 'helper-text': 'BVN: dial *565*0#. NIN: dial *346#.' },
                { type: 'DatePicker', name: 'dob', label: 'Date of birth', required: true, 'helper-text': 'As it is on your BVN or NIN' },
                { type: 'TextCaption', text: '🔒 We store only the result, never your BVN or NIN.' },
                { type: 'Footer', label: 'Check my ID', 'on-click-action': { name: 'complete', payload: { method: '${data.method}', number: '${form.number}', dob: '${form.dob}' } } },
              ],
            },
          ],
        },
      },
    ],
  };
}

export function kycFlowName(json: object = kycFlowJson()): string {
  return 'hoolam_kyc_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);
}
