// === DOM Elements ===
const overlay = document.getElementById('settings-overlay');
const apiKeyInput = document.getElementById('api-key-input');
const systemPromptInput = document.getElementById('system-prompt-input');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const copyBtn = document.getElementById('copy-btn');
const errorMsg = document.getElementById('error-message');
const transcriptContent = document.getElementById('transcript-content');
const welcomeMsg = document.getElementById('welcome-message');
const recordingDot = document.getElementById('recording-dot');
const statusText = document.getElementById('status-text');
const typingIndicator = document.getElementById('typing-indicator');

// === State Variables ===
let websocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let isRecording = false;

// We will buffer the PCM data to send in larger chunks.
// A larger chunk (e.g., 1.5 seconds) delays the translation slightly but provides 
// the Gemini model with much more context per request, significantly improving quality.
const PCM_BUFFER_SIZE = 16000 * 1.5; // 1.5s at 16kHz = 24000 samples
let pcmBuffer = [];

// Wait for DOM load
document.addEventListener('DOMContentLoaded', () => {
    // 1. Check for API key in URL (e.g., ?key=XYZ or ?apikey=XYZ)
    const urlParams = new URLSearchParams(window.location.search);
    const urlKey = urlParams.get('key') || urlParams.get('apikey');
    
    if (urlKey) {
        apiKeyInput.value = urlKey;
        localStorage.setItem('geminiApiKey', urlKey);
        
        // Clean the URL so the API key isn't permanently visible in the address bar
        window.history.replaceState({}, document.title, window.location.pathname);
    } else {
        // Fall back to saved local storage key
        const savedKey = localStorage.getItem('geminiApiKey');
        if (savedKey) {
            apiKeyInput.value = savedKey;
        }
    }

    // Load saved prompt
    const savedPrompt = localStorage.getItem('geminiSystemPrompt');
    if (savedPrompt) {
        systemPromptInput.value = savedPrompt;
    }
});

// === SVG Constants ===
const PAUSE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
const PLAY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const COPY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

// === Event Listeners ===
startBtn.addEventListener('click', startTranslation);

stopBtn.addEventListener('click', () => {
    if (isRecording) {
        stopTranslation();
    } else {
        startTranslation();
    }
});

copyBtn.addEventListener('click', () => {
    const textLines = Array.from(transcriptContent.children)
        .filter(el => !el.classList.contains('welcome-message') && !el.classList.contains('partial'))
        .map(el => el.innerText)
        .filter(text => text.trim() !== '');

    const textToCopy = textLines.join('\n');
    if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            copyBtn.innerHTML = CHECK_SVG;
            setTimeout(() => { copyBtn.innerHTML = COPY_SVG; }, 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
        });
    }
});

// Allow pressing Enter in the API key input
apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') startTranslation();
});

// === Functions ===

function base64Encode(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function startTranslation() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        errorMsg.textContent = "Please enter your Gemini API Key.";
        return;
    }

    const systemPromptText = systemPromptInput.value.trim() || "You are a real-time translator.";

    // Save settings
    localStorage.setItem('geminiApiKey', apiKey);
    localStorage.setItem('geminiSystemPrompt', systemPromptText);

    errorMsg.textContent = "Requesting microphone access...";

    try {
        // 1. Get Microphone Access
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000 // Request 16kHz from the browser natively if possible
            }
        });

        // 2. Setup Audio Context
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
        });

        // Load the AudioWorklet via a Blob URL to avoid CORS issues on file:// protocol
        const workletCode = `
            class PCMProcessor extends AudioWorkletProcessor {
              process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (input.length > 0) {
                  const channelData = input[0]; 
                  const pcm16 = new Int16Array(channelData.length);
                  for (let i = 0; i < channelData.length; i++) {
                    let s = Math.max(-1, Math.min(1, channelData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                  }
                  this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
                }
                return true; 
              }
            }
            registerProcessor('pcm-processor', PCMProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);

        try {
            await audioContext.audioWorklet.addModule(workletUrl);
        } catch (err) {
            console.error("Failed to load audio worklet.", err);
            errorMsg.textContent = "Cannot load audio processor. Please run via a local web server (e.g. Live Server).";
            return;
        }

        const source = audioContext.createMediaStreamSource(mediaStream);
        audioProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');

        // 3. Connect WebSocket
        console.log("Starting WebSocket connection...");
        errorMsg.textContent = "Connecting to Gemini Live API...";
        const MODEL_NAME = "gemini-3.5-live-translate-preview";
        const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

        websocket = new WebSocket(WS_URL);

        websocket.onopen = () => {
            console.log('WebSocket Connected successfully');

            // Send Setup Message
            const setupMessage = {
                setup: {
                    model: `models/${MODEL_NAME}`,
                    systemInstruction: {
                        parts: [{ text: systemPromptText }]
                    },
                    generationConfig: {
                        responseModalities: ["AUDIO"], // Model expects AUDIO modalities
                        translationConfig: {
                            sourceLanguageCode: 'zh', // Lock input to Chinese to prevent misidentifying poor audio
                            targetLanguageCode: 'en', // 'en' works, 'en-US' crashes the server!
                            echoTargetLanguage: false
                        }
                    }
                }
            };
            console.log("Sending setup message:", JSON.stringify(setupMessage, null, 2));
            websocket.send(JSON.stringify(setupMessage));
        };

        let chunkCounter = 0;
        let setupComplete = false;

        audioProcessor.port.onmessage = (e) => {
            if (!setupComplete) return;

            const pcm16Buffer = e.data;
            const int16Array = new Int16Array(pcm16Buffer);

            // Add to our buffer
            for (let i = 0; i < int16Array.length; i++) {
                pcmBuffer.push(int16Array[i]);
            }

            // Send chunk if it reaches our desired size
            if (pcmBuffer.length >= PCM_BUFFER_SIZE) {
                const chunkToSend = new Int16Array(pcmBuffer);
                pcmBuffer = []; // reset

                const base64Data = base64Encode(chunkToSend.buffer);
                const audioMessage = {
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: 'audio/pcm;rate=16000',
                            data: base64Data
                        }]
                    }
                };

                if (websocket.readyState === WebSocket.OPEN) {
                    chunkCounter++;
                    if (chunkCounter % 10 === 0) {
                        console.log(`Sent ${chunkCounter} audio chunks so far...`);
                    }
                    websocket.send(JSON.stringify(audioMessage));
                }
            }
        };

        websocket.onmessage = async (event) => {
            let data = event.data;
            // The API might send binary Blobs instead of plain text JSON
            if (data instanceof Blob) {
                console.debug("Received Blob, converting to text...");
                data = await data.text();
            }

            try {
                const response = JSON.parse(data);

                if (response.setupComplete) {
                    console.log("Setup completed successfully!");
                    setupComplete = true;

                    // Start processing audio
                    source.connect(audioProcessor);
                    audioProcessor.connect(audioContext.destination); // Required for some browsers to keep the worklet running

                    // Update UI
                    isRecording = true;
                    overlay.classList.add('hidden');
                    stopBtn.innerHTML = PAUSE_SVG;
                    stopBtn.classList.remove('hidden');
                    copyBtn.classList.remove('hidden');
                    if (welcomeMsg) welcomeMsg.style.display = 'none';
                    recordingDot.classList.add('active');
                    statusText.textContent = "Listening and translating...";
                    // Do not clear transcriptContent.innerHTML to allow resume behavior
                }

                if (response.serverContent) {
                    const content = response.serverContent;

                    // Original input transcription
                    if (content.inputTranscription) {
                        console.log("Original speech:", content.inputTranscription.text);
                        displayOriginal(content.inputTranscription.text);
                    }

                    // Translated output
                    if (content.outputTranscription) {
                        console.log("Received output transcription:", content.outputTranscription.text);
                        displayTranslation(content.outputTranscription.text);
                    } else if (content.modelTurn && content.modelTurn.parts) {
                        content.modelTurn.parts.forEach(part => {
                            if (part.text) {
                                console.log("Received model text:", part.text);
                                displayTranslation(part.text);
                            }
                        });
                    }
                }

                if (response.error) {
                    console.error("API Error Response:", response.error);
                }
            } catch (err) {
                console.error("Error parsing WebSocket message:", err, data);
            }
        };

        websocket.onerror = (err) => {
            console.error("WebSocket Error triggered:", err);
            errorMsg.textContent = "Connection error. Check console for details.";
        };

        websocket.onclose = (e) => {
            console.log("WebSocket Closed with code:", e.code, "reason:", e.reason);
            if (e.reason) {
                errorMsg.textContent = `Closed: ${e.reason}`;
            }
            stopTranslation();
        };

    } catch (err) {
        console.error("Microphone or API Error:", err);
        errorMsg.textContent = "Could not access microphone. Please allow permissions.";
    }
}

function stopTranslation() {
    isRecording = false;

    // Stop Audio
    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop WebSocket
    if (websocket) {
        websocket.close();
        websocket = null;
    }

    // Update UI for pause state
    stopBtn.innerHTML = PLAY_SVG;
    recordingDot.classList.remove('active');
    statusText.textContent = "Paused";
    typingIndicator.classList.add('hidden');
}

function scrollToBottom() {
    const container = document.querySelector('.transcript-container');
    container.scrollTop = container.scrollHeight;
}

let currentBlock = null;
let pauseTimeout = null;

function resetPauseTimeout() {
    if (pauseTimeout) clearTimeout(pauseTimeout);
    pauseTimeout = setTimeout(() => {
        // If 3 seconds pass with no new text (a long pause), break the block 
        // so the next spoken words start on a fresh new line.
        currentBlock = null;
    }, 3000);
}

function getOrCreateBlock() {
    if (!currentBlock) {
        currentBlock = document.createElement('div');
        currentBlock.className = 'transcript-block';

        const orig = document.createElement('div');
        orig.className = 'transcript-line original';
        currentBlock.appendChild(orig);

        const trans = document.createElement('div');
        trans.className = 'transcript-line translation';
        currentBlock.appendChild(trans);

        transcriptContent.appendChild(currentBlock);
    }
    return currentBlock;
}

function displayOriginal(text) {
    if (!text) return;
    const block = getOrCreateBlock();
    const orig = block.querySelector('.original');

    // Append text to the current block, ensuring spacing
    const space = orig.textContent && !orig.textContent.endsWith(' ') ? ' ' : '';
    orig.textContent += space + text.trim();
    scrollToBottom();

    resetPauseTimeout();
}

function displayTranslation(text, isPartial = false) {
    if (!text) return;
    const block = getOrCreateBlock();
    const trans = block.querySelector('.translation');

    // Append text to the current block, ensuring spacing
    const space = trans.textContent && !trans.textContent.endsWith(' ') ? ' ' : '';
    trans.textContent += space + text.trim();

    // Check if the translation ends with sentence-ending punctuation.
    // If so, finish the block so the next spoken words start a new block.
    if (/[.!?。！？]\s*$/.test(text.trim())) {
        currentBlock = null;
    }

    scrollToBottom();
    resetPauseTimeout();
}
