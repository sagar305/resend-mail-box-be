import './helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/ApiError.js';
import {
  assertRecipientsResolvable,
  extractTokens,
  renderForRecipient,
  renderTemplate,
  toValueMap,
} from '../src/lib/merge.js';

describe('extractTokens', () => {
  it('finds tokens across subject and body', () => {
    const tokens = extractTokens('Hi {{name}}', '<p>Your plan is {{plan}}</p>', '');
    assert.deepEqual(tokens.sort(), ['name', 'plan']);
  });

  it('treats spacing and casing inside a token as the same column', () => {
    assert.deepEqual(extractTokens('{{ First Name }} {{first name}}'), ['first name']);
  });

  it('returns nothing for a template with no tokens', () => {
    assert.deepEqual(extractTokens('Hello there', '<p>No tokens</p>'), []);
  });
});

describe('renderTemplate', () => {
  it('substitutes a value', () => {
    assert.equal(renderTemplate('Hi {{name}}', toValueMap({ name: 'Sagar' })), 'Hi Sagar');
  });

  it('matches a token to its column regardless of case or spacing', () => {
    const values = toValueMap({ 'First Name': 'Sagar' });
    assert.equal(renderTemplate('Hi {{first name}}', values), 'Hi Sagar');
  });

  it('escapes values going into HTML', () => {
    // A pasted spreadsheet can hold anything. Unescaped, this would break the
    // markup around it at best.
    const values = toValueMap({ company: 'Smith & Sons <Ltd>' });
    assert.equal(
      renderTemplate('<p>{{company}}</p>', values, { html: true }),
      '<p>Smith &amp; Sons &lt;Ltd&gt;</p>',
    );
  });

  it('leaves values alone in a subject line', () => {
    const values = toValueMap({ company: 'Smith & Sons' });
    assert.equal(renderTemplate('Welcome, {{company}}', values), 'Welcome, Smith & Sons');
  });

  it('does not resolve tokens that came from a value', () => {
    // Data must not reach back into the template and pull in another column.
    const values = toValueMap({ name: '{{secret}}', secret: 'leaked' });
    assert.equal(renderTemplate('Hi {{name}}', values), 'Hi {{secret}}');
  });
});

describe('assertRecipientsResolvable', () => {
  const tokens = ['name'];

  it('passes when every row can fill every token', () => {
    assert.doesNotThrow(() => assertRecipientsResolvable(
      [{ email: 'a@example.test', vars: { name: 'A' } }],
      tokens,
    ));
  });

  it('passes trivially when the template has no tokens', () => {
    assert.doesNotThrow(() => assertRecipientsResolvable(
      [{ email: 'a@example.test', vars: {} }],
      [],
    ));
  });

  it('blocks the job when a value is missing, naming the row', () => {
    assert.throws(
      () => assertRecipientsResolvable(
        [
          { email: 'a@example.test', vars: { name: 'A' } },
          { email: 'b@example.test', vars: {} },
        ],
        tokens,
      ),
      (error) => error instanceof ApiError
        && error.status === 422
        && error.code === 'merge_values_missing'
        && error.message.includes('b@example.test'),
    );
  });

  it('treats a blank value as missing', () => {
    // "Hi ," is the outcome this exists to prevent, and whitespace produces it
    // just as well as an absent column does.
    assert.throws(
      () => assertRecipientsResolvable([{ email: 'b@example.test', vars: { name: '   ' } }], tokens),
      (error) => error.code === 'merge_values_missing',
    );
  });

  it('summarizes rather than listing every row when many are broken', () => {
    const recipients = Array.from({ length: 9 }, (_unused, index) => ({
      email: `person${index}@example.test`,
      vars: {},
    }));
    assert.throws(
      () => assertRecipientsResolvable(recipients, tokens),
      (error) => /9 recipients are missing values/.test(error.message)
        && /and 4 more/.test(error.message),
    );
  });
});

describe('renderForRecipient', () => {
  it('renders subject, html and text with the right escaping for each', () => {
    const rendered = renderForRecipient(
      {
        subject: 'Hi {{name}} at {{company}}',
        html: '<p>Hi {{name}}, welcome to {{company}}</p>',
        text: 'Hi {{name}}, welcome to {{company}}',
      },
      { name: 'Sagar', company: 'Smith & Sons' },
    );

    assert.equal(rendered.subject, 'Hi Sagar at Smith & Sons');
    assert.equal(rendered.html, '<p>Hi Sagar, welcome to Smith &amp; Sons</p>');
    assert.equal(rendered.text, 'Hi Sagar, welcome to Smith & Sons');
  });
});
