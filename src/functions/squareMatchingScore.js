export function scoreSquareDeliveryCandidate({ item, delivery, patient, normalizeText, normalizeMatchName, tokenizeName, levenshteinDistance, parseDateValue }) {
  const patientName = patient?.full_name;
  if (!patientName) return -1;

  const combinedText = `${normalizeText(item?.note || '')} ${normalizeText(item?.item_name || '')}`.trim();
  const normalizedText = normalizeMatchName(combinedText).replace(/[^a-z0-9\s]/g, ' ');
  const normalizedPatient = normalizeMatchName(patientName).replace(/[^a-z0-9\s]/g, ' ');
  const patientTokens = tokenizeName(normalizedPatient);
  const textTokens = tokenizeName(normalizedText);

  let nameScore = 0;
  if (normalizedText && normalizedPatient && normalizedText.includes(normalizedPatient)) {
    nameScore = 100;
  } else {
    let matchedTokens = 0;
    for (const patientToken of patientTokens) {
      const exactToken = textTokens.find((textToken) => textToken === patientToken);
      if (exactToken) {
        matchedTokens += 1;
        nameScore += 30;
        continue;
      }
      const partialToken = textTokens.find((textToken) => textToken.includes(patientToken) || patientToken.includes(textToken));
      if (partialToken) {
        matchedTokens += 1;
        nameScore += 20;
        continue;
      }
      const fuzzyToken = textTokens.find((textToken) => {
        const distance = levenshteinDistance(patientToken, textToken);
        const maxLength = Math.max(patientToken.length, textToken.length);
        return maxLength >= 4 && distance <= 1;
      });
      if (fuzzyToken) {
        matchedTokens += 1;
        nameScore += 12;
      }
    }
    if (matchedTokens === patientTokens.length && patientTokens.length > 0) nameScore += 15;
    if (patientTokens.length >= 2 && matchedTokens >= 2) nameScore += 10;
  }

  const transactionDate = parseDateValue(item?.payment_date || item?.order_created_at);
  const deliveryDate = parseDateValue(delivery?.delivery_date);
  let dateScore = 0;
  if (transactionDate && deliveryDate) {
    transactionDate.setHours(0, 0, 0, 0);
    deliveryDate.setHours(0, 0, 0, 0);
    const diffDays = Math.abs(Math.round((transactionDate.getTime() - deliveryDate.getTime()) / (24 * 60 * 60 * 1000)));
    if (diffDays === 0) dateScore = 40;
    else if (diffDays === 1) dateScore = 25;
    else if (diffDays === 2) dateScore = 10;
  }

  return nameScore + dateScore;
}