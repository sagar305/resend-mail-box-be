import { randomUUID } from 'node:crypto';
import { getAttachmentBucket } from '../db.js';

/*
 * Attachments parked in GridFS until the mail they belong to is handed to Resend.
 *
 * Used by anything that holds a send rather than making it straight away: a bulk
 * job while it drains, and a scheduled mail while it waits for its delivery day —
 * which can be up to thirty days.
 *
 * They cannot live in the owning document. Twenty megabytes of files is about
 * twenty-seven once base64 encoded, against Mongo's sixteen megabyte ceiling —
 * the same wall that makes a saved draft drop its attachments. GridFS chunks them
 * instead, which is what lets a mail keep its files across a redeploy, or across
 * the days between being scheduled and being sent.
 *
 * The bytes are stored decoded. Re-encoding at send time is cheap next to the
 * network call that follows it, and storing base64 would inflate the stored size
 * by a third for no benefit.
 */

/** Store one owner's attachments and return the metadata its document holds. */
export async function stageAttachments(ownerId, attachments) {
  if (!attachments?.length) return [];

  const bucket = getAttachmentBucket();
  const staged = [];

  for (const attachment of attachments) {
    const fileId = `${ownerId}:${randomUUID()}`;
    const bytes = Buffer.from(attachment.content, 'base64');

    await new Promise((resolve, reject) => {
      const stream = bucket.openUploadStreamWithId(fileId, attachment.filename, {
        metadata: { ownerId, contentType: attachment.contentType ?? null },
      });
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(bytes);
    });

    staged.push({
      fileId,
      filename: attachment.filename,
      contentType: attachment.contentType ?? null,
      size: bytes.length,
    });
  }

  return staged;
}

/**
 * Read the files back, ready to hand to Resend.
 *
 * A bulk job calls this once per run rather than once per recipient: pulling the
 * same twenty megabytes out of the database sixty times over would dwarf the cost
 * of the sends themselves.
 */
export async function loadAttachments(staged) {
  if (!staged?.length) return [];

  const bucket = getAttachmentBucket();
  const loaded = [];

  for (const file of staged) {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = bucket.openDownloadStream(file.fileId);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });

    loaded.push({
      filename: file.filename,
      content: Buffer.concat(chunks).toString('base64'),
      ...(file.contentType ? { contentType: file.contentType } : {}),
    });
  }

  return loaded;
}

/**
 * Drop files once the mail they belong to has left. Best effort: a send that
 * happened is done whether or not its temporary files were tidied away, and
 * failing it over a cleanup error would be the wrong outcome.
 */
export async function discardAttachments(staged) {
  if (!staged?.length) return;

  const bucket = getAttachmentBucket();
  for (const file of staged) {
    try {
      await bucket.delete(file.fileId);
    } catch (error) {
      console.error(`Could not remove staged attachment ${file.fileId}: ${error.message}`);
    }
  }
}
