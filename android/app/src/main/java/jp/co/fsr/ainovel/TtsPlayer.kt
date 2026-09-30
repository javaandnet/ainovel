package jp.co.fsr.ainovel

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

/**
 * 本地朗读器：用系统 TextToSpeech 朗读章节正文（零联网、零流量）。
 * ainovel 服务端另有逐句 mp3 的 TTS 接口，客户端朗读不需要它——本地合成即时、可控语速，
 * 且不受桥接服务可用性影响。（对应 iOS SpeechPlayer / AVSpeechSynthesizer）
 */
class TtsPlayer(context: Context) {
    var speaking by mutableStateOf(false)
        private set

    private var ready = false
    private var lastUtteranceId: String? = null
    private val tts: TextToSpeech

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                // zh-CN 不可用时静默回落默认语言，不阻断播放
                runCatching { tts.setLanguage(Locale.CHINA) }
                ready = true
            }
        }
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                speaking = true
            }

            override fun onDone(utteranceId: String?) {
                // 队列里最后一句读完才算停止
                if (utteranceId == null || utteranceId == lastUtteranceId) speaking = false
            }

            @Deprecated("deprecated in API level 21")
            override fun onError(utteranceId: String?) {
                speaking = false
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                speaking = false
            }
        })
    }

    /** 切段：按换行分段，过滤纯空白 */
    companion object {
        fun split(text: String): List<String> =
            text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
    }

    fun start(text: String, rate: Float = 0.9f) {
        stop()
        if (!ready) return
        val paragraphs = split(text)
        if (paragraphs.isEmpty()) return
        lastUtteranceId = null
        for ((i, p) in paragraphs.withIndex()) {
            val id = "para_$i"
            lastUtteranceId = id
            tts.speak(p, TextToSpeech.QUEUE_ADD, null, id)
        }
        speaking = true
    }

    fun stop() {
        tts.stop()
        speaking = false
    }

    fun shutdown() {
        runCatching { tts.shutdown() }
    }
}
