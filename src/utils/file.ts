import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as tar from 'tar';

/**
 * Downloads a file from a URL to a local path
 */
export async function downloadFile(
  url: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(outputPath);

    protocol
      .get(url, (response) => {
        if (response.statusCode === 200) {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        } else {
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
          );
        }
      })
      .on('error', (err) => {
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(err);
      });
  });
}

/**
 * Extracts a tar.gz archive to a directory and finds a specific file
 */
export async function extractArchiveAndFindFile(
  archivePath: string,
  extractDir: string,
  targetFileName: string,
  logger?: any,
): Promise<string | null> {
  try {
    // Create extraction directory
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Extract the tar.gz archive
    await tar.extract({
      file: archivePath,
      cwd: extractDir,
    });

    // Look for the target file recursively
    const filePath = await findFileRecursively(extractDir, targetFileName);

    if (filePath) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return fileContent;
    }

    return null;
  } catch (error) {
    if (logger) {
      logger.error(`Error extracting archive: ${error}`);
    }
    return null;
  }
}

/**
 * Recursively searches for a file by name in a directory
 */
export async function findFileRecursively(
  dir: string,
  fileName: string,
): Promise<string | null> {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      const result = await findFileRecursively(filePath, fileName);
      if (result) return result;
    } else if (file === fileName) {
      return filePath;
    }
  }

  return null;
}

/**
 * Cleans up files and directories
 */
export async function cleanupFiles(
  paths: string[],
  logger?: any,
): Promise<void> {
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      if (logger) {
        logger.warn(`Failed to cleanup ${filePath}: ${error}`);
      }
    }
  }
}

/**
 * Ensures a directory exists, creating it if necessary
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Downloads an archive, extracts it, and finds a specific file
 * This is a high-level utility that combines download, extract, and find operations
 */
export async function downloadExtractAndFindFile(
  downloadUrl: string,
  tempDir: string,
  archiveName: string,
  extractDirName: string,
  targetFileName: string,
  logger?: any,
): Promise<{ content: string | null; cleanup: () => Promise<void> }> {
  const archivePath = path.join(tempDir, archiveName);
  const extractDir = path.join(tempDir, extractDirName);

  // Ensure temp directory exists
  ensureDirectoryExists(tempDir);

  try {
    // Download the archive
    if (logger) {
      logger.info(`Downloading archive...`);
    }
    await downloadFile(downloadUrl, archivePath);

    // Extract and find the target file
    if (logger) {
      logger.info(`Extracting archive to look for ${targetFileName}...`);
    }
    const content = await extractArchiveAndFindFile(
      archivePath,
      extractDir,
      targetFileName,
      logger,
    );

    // Return content and cleanup function
    return {
      content,
      cleanup: async () => {
        await cleanupFiles([archivePath, extractDir], logger);
      },
    };
  } catch (error) {
    // Cleanup on error
    await cleanupFiles([archivePath, extractDir], logger);
    throw error;
  }
}

/**
 * Ensures a directory exists, creating it if necessary
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generates a timestamped filename
 */
export function generateTimestampedFilename(
  prefix: string,
  extension: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${timestamp}.${extension}`;
}
