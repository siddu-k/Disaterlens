/**
 * DisasterLens / TerraLab — Text-to-Speech (TTS) Voice Engine
 * Replicates the Web Speech API narration from voice-handler.js
 */

class VoiceEngine {
  private enabled: boolean;
  private synth: SpeechSynthesis | null;
  private currentUtterance: SpeechSynthesisUtterance | null;
  private voices: SpeechSynthesisVoice[];

  constructor() {
    this.enabled = typeof window !== 'undefined' && localStorage.getItem('terralab_voice_enabled') === 'true';
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.currentUtterance = null;
    this.voices = [];

    if (this.synth) {
      this.synth.onvoiceschanged = () => {
        this.voices = this.synth?.getVoices() || [];
      };
      this.voices = this.synth.getVoices();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public toggle(): boolean {
    this.enabled = !this.enabled;
    if (typeof window !== 'undefined') {
      localStorage.setItem('terralab_voice_enabled', String(this.enabled));
    }
    if (!this.enabled && this.synth && this.synth.speaking) {
      this.synth.cancel();
    }
    if (this.enabled) {
      this.speak('Voice assistance enabled', true);
    }
    return this.enabled;
  }

  public speak(text: string, force: boolean = false): void {
    if (!this.synth) return;
    if (!this.enabled && !force) return;

    try {
      this.synth.cancel();
      // Clean HTML tags and markdown asterisks
      const cleanText = text.replace(/<[^>]*>?/gm, '').replace(/\*+/g, '').replace(/#+/g, '').trim();
      if (!cleanText) return;

      const utterance = new SpeechSynthesisUtterance(cleanText);
      if (this.voices.length === 0) {
        this.voices = this.synth.getVoices();
      }
      const preferred = this.voices.find((v) => v.name.includes('Google') || v.name.includes('Natural')) || this.voices[0];
      if (preferred) utterance.voice = preferred;

      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      this.currentUtterance = utterance;
      this.synth.speak(utterance);
    } catch (err) {
      console.error('VoiceEngine error:', err);
    }
  }
}

export const voiceEngine = new VoiceEngine();
