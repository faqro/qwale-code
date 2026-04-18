function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function normalizeOperation(raw) {
  const op = raw && typeof raw === 'object' ? raw : {};
  const offset = Math.max(0, Number(op.offset) || 0);
  const deleteCount = Math.max(0, Number(op.deleteCount) || 0);
  const insertText = String(op.insertText || '');
  return { offset, deleteCount, insertText };
}

function mapPositionThroughAppliedOperation(position, applied, preferAfterInsert) {
  const op = normalizeOperation(applied);
  const insertLength = op.insertText.length;
  const removeStart = op.offset;
  const removeEnd = op.offset + op.deleteCount;

  if (position < removeStart) {
    return position;
  }

  if (position > removeEnd) {
    return position + insertLength - op.deleteCount;
  }

  if (position === removeStart && preferAfterInsert && op.deleteCount === 0 && insertLength > 0) {
    return removeStart + insertLength;
  }

  return removeStart + (preferAfterInsert ? insertLength : 0);
}

function transformOperationAgainstApplied(operation, appliedOperation) {
  const source = normalizeOperation(operation);
  const applied = normalizeOperation(appliedOperation);

  const start = mapPositionThroughAppliedOperation(source.offset, applied, true);
  const end = mapPositionThroughAppliedOperation(source.offset + source.deleteCount, applied, true);

  return {
    offset: Math.max(0, start),
    deleteCount: Math.max(0, end - start),
    insertText: source.insertText
  };
}

function applyOperationToText(text, rawOperation) {
  const input = typeof text === 'string' ? text : '';
  const operation = normalizeOperation(rawOperation);
  const safeOffset = clampNumber(operation.offset, 0, input.length);
  const safeDeleteCount = clampNumber(operation.deleteCount, 0, input.length - safeOffset);

  return input.slice(0, safeOffset) + operation.insertText + input.slice(safeOffset + safeDeleteCount);
}

function applyOperationBatchToText(text, operations) {
  const opList = Array.isArray(operations) ? operations.map((entry) => normalizeOperation(entry)) : [];
  let current = typeof text === 'string' ? text : '';
  let delta = 0;

  for (const op of opList) {
    const adjusted = {
      offset: Math.max(0, op.offset + delta),
      deleteCount: op.deleteCount,
      insertText: op.insertText
    };

    current = applyOperationToText(current, adjusted);
    delta += op.insertText.length - op.deleteCount;
  }

  return current;
}

module.exports = {
  normalizeOperation,
  transformOperationAgainstApplied,
  applyOperationToText,
  applyOperationBatchToText
};