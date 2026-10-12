import { createHash } from 'node:crypto';

/**
 * THE ID CHECK FORM (WhatsApp Flow): BVN or NIN, the number and the date of birth, on one screen.
 * Static form: the answers arrive in the webhook when they tap "Check my ID". The chat blanks that message
 * once it's read, so the number is never kept. Changing anything here creates a new form on Meta.
 */
export function kycFlowJson() {
  return {
    version: '7.3',
    screens: [
      {
        id: 'ID',
        title: 'Quick ID check',
        terminal: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form', name: 'form',
              children: [
                { type: 'TextSubheading', text: 'Check your ID, once' },
                { type: 'TextBody', text: 'Choose BVN or NIN. Use the date of birth on it.' },
                { type: 'RadioButtonsGroup', name: 'method', label: 'Which one?', required: true, 'data-source': [{ id: 'BVN', title: 'BVN' }, { id: 'NIN', title: 'NIN' }] },
                { type: 'TextInput', name: 'number', label: 'The 11-digit number', 'input-type': 'number', required: true, 'min-chars': 11, 'max-chars': 11, 'helper-text': 'BVN: dial *565*0#. NIN: dial *346#.' },
                { type: 'DatePicker', name: 'dob', label: 'Date of birth', required: true },
                { type: 'TextCaption', text: '🔒 We store only the result, never your BVN or NIN.' },
                { type: 'Footer', label: 'Check my ID', 'on-click-action': { name: 'complete', payload: { method: '${form.method}', number: '${form.number}', dob: '${form.dob}' } } },
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
