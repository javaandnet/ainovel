package jp.co.fsr.ainovel.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// MARK: - 认证

/** 当前登录用户（/api/me、/api/login 的 user 字段；未登录时 user 为 null） */
@Serializable
data class UserSession(
    val id: String? = null,
    val username: String? = null,
    val role: String? = null,
) {
    val isSuperadmin: Boolean get() = role == "superadmin"
    val display: String get() = username ?: "已登录"
}

@Serializable
data class MeResponse(val ok: Boolean? = null, val user: UserSession? = null)

@Serializable
data class LoginResponse(val ok: Boolean? = null, val user: UserSession? = null)

// MARK: - 小说

@Serializable
data class Novel(
    val id: String? = null,
    val name: String? = null,
    val chapterCount: Int? = null,
    val updatedAt: Double? = null,
    val vip: Boolean? = null,
) {
    val display: String get() = name ?: "未命名"
    val chaptersDesc: String get() = "共 ${chapterCount ?: 0} 章"
}

@Serializable
data class NovelsResponse(val novels: List<Novel>? = null)

@Serializable
data class CreateNovelResponse(val ok: Boolean? = null, val novel: Novel? = null)

// MARK: - 章节

@Serializable
data class Chapter(
    val no: Int? = null,
    val name: String? = null,
    val outline: String? = null,
    val wordCount: Int? = null,
    val hasContent: Boolean? = null,
    val partNo: Int? = null,
    val id: String? = null,
) {
    val display: String get() = name ?: "第 ${no ?: 0} 章"
    val wordsDesc: String
        get() {
            val w = wordCount ?: 0
            if (w == 0) return "—"
            return if (w >= 10000) String.format("%.1f万字", w / 10000.0) else "${w}字"
        }
}

@Serializable
data class ChaptersResponse(
    val novel: String? = null,
    val chapters: List<Chapter>? = null,
    val totalWords: Int? = null,
)

@Serializable
data class ChapterDetail(
    val no: Int? = null,
    val name: String? = null,
    val outline: String? = null,
    val content: String? = null,
    val wordCount: Int? = null,
    val outlineCount: Int? = null,
)

@Serializable
data class ChapterResponse(val chapter: ChapterDetail? = null)

// MARK: - 设定

@Serializable
data class GenCfg(
    var targetWords: Int? = null,
    var tolerancePct: Int? = null,
    var splitPct: Int? = null,
)

@Serializable
data class WordBand(
    val min: Int? = null,
    val max: Int? = null,
    val target: Int? = null,
    val splitLine: Int? = null,
)

@Serializable
data class NovelSettings(
    val name: String? = null,
    val outline: String? = null,
    val content: String? = null,
    val preface: String? = null,
    val version: Int? = null,
    val genCfg: GenCfg? = null,
    val wordBand: WordBand? = null,
    val wordBandText: String? = null,
    val chapterCount: Int? = null,
    val outlineCount: Int? = null,
    val bodyCount: Int? = null,
    val totalWords: Int? = null,
)

@Serializable
data class SaveSettingsResponse(
    val ok: Boolean? = null,
    val action: String? = null,
    val version: Int? = null,
    val genCfg: GenCfg? = null,
    val wordBand: WordBand? = null,
)

// MARK: - 分部

@Serializable
data class Part(
    val no: Int? = null,
    val name: String? = null,
    val startNo: Int? = null,
    val endNo: Int? = null,
    val chapters: Int? = null,
    val hasIntro: Boolean? = null,
)

@Serializable
data class PartsResponse(val parts: List<Part>? = null)

// MARK: - 阅读器 AI（公开）

@Serializable
data class QuizQuestion(
    val question: String? = null,
    val options: List<String>? = null,
    val answer: String? = null,
)

@Serializable
data class QuizResponse(val ok: Boolean? = null, val questions: List<QuizQuestion>? = null)

@Serializable
data class VocabResponse(val ok: Boolean? = null, val words: List<String>? = null)

@Serializable
data class ExplainResponse(val ok: Boolean? = null, val explanation: String? = null)

@Serializable
data class AskResponse(val ok: Boolean? = null, val answer: String? = null)

@Serializable
data class FeedbackResponse(val ok: Boolean? = null, val feedback: String? = null)

@Serializable
data class WordStatusResponse(val ok: Boolean? = null, val have: List<String>? = null)

// MARK: - 分享 / 发布 / 检查

@Serializable
data class ShareResponse(val url: String? = null, val published: Boolean? = null, val title: String? = null)

@Serializable
data class PublishResponse(
    val success: Boolean? = null,
    val pages: Int? = null,
    val chapters: Int? = null,
    val pruned: Int? = null,
    val pruneSkipped: String? = null,
    val url: String? = null,
)

// MARK: - 通用动作 /api/run

@Serializable
data class RunResponse(
    val success: Boolean? = null,
    val action: String? = null,
    val novelId: String? = null,
    val result: JsonElement? = null,
) {
    /** 取字符串（供界面直接展示 result 里的文本类返回） */
    val resultText: String?
        get() = (result as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}

@Serializable
data class CheckResponse(val success: Boolean? = null, val report: JsonElement? = null)

@Serializable
data class LLMStatus(
    val ok: Boolean? = null,
    val reachable: Boolean? = null,
    val detail: String? = null,
    val model: String? = null,
)

@Serializable
data class RenumberResponse(val ok: Boolean? = null, val shiftedCount: Int? = null)

@Serializable
data class OkResponse(val ok: Boolean? = null, val error: String? = null)

@Serializable
data class VipResponse(val ok: Boolean? = null, val vip: Boolean? = null)

@Serializable
data class OutlineDraft(val ok: Boolean? = null, val outline: String? = null, val name: String? = null)
