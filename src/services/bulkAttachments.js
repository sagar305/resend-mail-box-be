import { randomUUID } from 'node:crypto';
import { getAttachmentBucket } from '../db.js';

/*
 * A bulk job's attachments, parked in GridFS for the life of the job.
 *
 * They cannot live in the job document. Twenty megabytes of files is about
 * twenty-seven once base64 encoded, against Mongo's sixteen megabyte ceiling —
 * the same wall that makes a saved draft drop its attachments. GridFS chunks
 * them instead, which is what lets a job interrupted by a redeploy still have
 * its files when it starts again.
 *
 * The bytes are stored decoded. Re-encoding per recipient is cheap next to the
 * network call that follows it, and storing base64 would inflate the stored size
 * by a third for no benefit.
 */

/** Store one job's attachments and return the metadata the job document holds. */
export async function stageAttachments(jobId, attachments) {
  if (!attachments?.length) return [];

  const bucket = getAttachmentBucket();
  const staged = [];

  for (const attachment of attachments) {
    const fileId = `${jobId}:${randomUUID()}`;
    const bytes = Buffer.from(attachment.content, 'base64');

    await new Promise((resolve, reject) => {
      const stream = bucket.openUploadStreamWithId(fileId, attachment.filename, {
        metadata: { jobId, contentType: attachment.contentType ?? null },
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
 * Read a job's files back, ready to hand to Resend.
 *
 * Called once per job run rather than once per recipient: pulling the same
 * twenty megabytes out of the database sixty times over would dwarf the cost of
 * the sends themselves. A restart pays for one more read, which is the right
 * trade.
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
 * Drop a finished job's files. Best effort: a job that has sent everything is
 * done whether or not its temporary files were tidied away, and failing the job
 * over a cleanup error would be the wrong outcome.
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
