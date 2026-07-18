# Musee Audio Transcoder (Azure Functions)

This directory contains the serverless **Azure Functions** project responsible for downloading audio tracks from JioSaavn, transcoding them into multiple adaptive HLS bitrates (96k, 160k, 320k) using `ffmpeg`, and uploading them directly to Azure Blob Storage.

It is triggered via an **HTTP POST** request from the main Musee server.

---

## Technical Stack
*   **Runtime:** Node.js v18+ (programming model v4)
*   **Trigger:** HTTP POST (`/api/transcodeJioSaavn`)
*   **Transcoding:** `fluent-ffmpeg` powered by static binaries from `ffmpeg-static`
*   **Storage Uploads:** `@azure/storage-blob` SDK

---

## Azure Setup Guide

### 1. Azure Function App Setup
1. Log in to the [Azure Portal](https://portal.azure.com/).
2. Click **Create a resource** and search for **Function App**.
3. Configure the following:
   *   **Runtime stack:** Node.js
   *   **Version:** 18 or 20 (LTS)
   *   **Operating System:** Linux
   *   **Plan type:** Consumption (Serverless) or Flex Consumption
4. Link it to your existing storage account.
5. Create the Function App.

### 2. Application Settings (Environment Variables)
Navigate to your Function App -> **Configuration** (under Settings) and add the following **Application Settings**:
*   `AZURE_STORAGE_CONNECTION_STRING`: The connection string for your Azure Storage Account (same one used by Blob Storage).
*   `AZURE_STORAGE_CONTAINER`: The target container name for storing audio assets (defaults to `media` if not specified).

---

## Local Development & Testing

### Prerequisite: Install Azure Functions Core Tools
Install the Core Tools globally on your system to run the function app locally:
```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

### Setup Local Configuration
1. Install dependencies in this directory:
   ```bash
   cd azure-transcoder
   npm install
   ```
2. Make sure your `local.settings.json` is set up:
   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "FUNCTIONS_WORKER_RUNTIME": "node",
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "AZURE_STORAGE_CONNECTION_STRING": "<your-azure-storage-connection-string>",
       "AZURE_STORAGE_CONTAINER": "media"
     }
   }
   ```
   *(Note: Replace `<your-azure-storage-connection-string>` with your actual Azure Storage Account Connection String. Do not commit secrets to git).*

3. Run the function app locally:
   ```bash
   npm start
   ```

### Triggering a Test Message
To test the transcoder locally, send an HTTP POST request to `http://localhost:7071/api/transcodeJioSaavn`:

**Headers:**
*   `Content-Type: application/json`

**Body:**
```json
{
  "trackId": "test-track-uuid",
  "encryptedMediaUrl": "your_encrypted_media_url_here"
}
```

---

## Production Deployment

To deploy from your local CLI, use the Azure Functions Core Tools:
```bash
# Log in to Azure CLI first
az login

# Deploy to your Function App
func azure functionapp publish <your-function-app-name>
```

After deployment, obtain your function key (API key) from the Azure Portal (under **Function Keys**) and configure it on your main Musee server as `AZURE_TRANSCODER_CODE`.
