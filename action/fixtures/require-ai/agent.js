const { generateText } = require('ai');

async function go(resend) {
  void generateText;
  return resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}

module.exports = { go };
