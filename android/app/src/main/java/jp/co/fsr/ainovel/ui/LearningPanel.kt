package jp.co.fsr.ainovel.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.co.fsr.ainovel.AppConfig
import jp.co.fsr.ainovel.data.AskResponse
import jp.co.fsr.ainovel.data.ExplainResponse
import jp.co.fsr.ainovel.data.FeedbackResponse
import jp.co.fsr.ainovel.data.QuizResponse
import jp.co.fsr.ainovel.data.VocabResponse
import jp.co.fsr.ainovel.net.ApiClient
import jp.co.fsr.ainovel.net.Endpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 阅读器学习面板（测试/生词/提问），走公开 api/reader 系列端点。
 * 全屏弹层形式，对应 iOS LearningPanel sheet。
 */
class LearningViewModel {
    enum class Mode(val label: String) { Quiz("测试"), Vocab("生词"), Ask("提问") }

    var mode by mutableStateOf(Mode.Quiz)
    var questions by mutableStateOf<List<jp.co.fsr.ainovel.data.QuizQuestion>>(emptyList())
    var answers by mutableStateOf<Map<Int, String>>(emptyMap())
    var feedback by mutableStateOf<Map<Int, String>>(emptyMap())
    var words by mutableStateOf<List<String>>(emptyList())
    var explainWord by mutableStateOf<String?>(null)
    var explainText by mutableStateOf<String?>(null)
    var question by mutableStateOf("")
    var answer by mutableStateOf("")
    var busy by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    private val age = 9
    private val lang = "中文"

    private suspend inline fun <reified T> run(
        crossinline block: suspend () -> T,
        onResult: (T) -> Unit,
    ) {
        busy = true
        errorMessage = null
        try {
            onResult(block())
        } catch (e: Exception) {
            errorMessage = e.message
        }
        busy = false
    }

    fun loadQuiz(document: String, force: Boolean) {
        CoroutineScope(Dispatchers.Main).launch {
            run({
                val body = buildJsonObject {
                    put("document", document)
                    put("age", age)
                    if (force) put("force", true)
                }
                ApiClient.post<QuizResponse>(Endpoint.READER_QUIZ, body, AppConfig.LLM_TIMEOUT_SEC)
            }) { resp ->
                questions = resp.questions ?: emptyList()
                answers = emptyMap()
                feedback = emptyMap()
            }
        }
    }

    fun loadVocab(document: String) {
        CoroutineScope(Dispatchers.Main).launch {
            run({
                ApiClient.post<VocabResponse>(
                    Endpoint.READER_VOCAB,
                    buildJsonObject {
                        put("document", document)
                        put("age", age)
                    }, AppConfig.LLM_TIMEOUT_SEC)
            }) { resp -> words = resp.words ?: emptyList() }
        }
    }

    fun explain(word: String, context: String) {
        explainWord = word
        explainText = null
        CoroutineScope(Dispatchers.Main).launch {
            run({
                ApiClient.post<ExplainResponse>(
                    Endpoint.READER_EXPLAIN_WORD,
                    buildJsonObject {
                        put("word", word)
                        put("age", age)
                        put("lang", lang)
                        put("context", context)
                    }, AppConfig.LLM_TIMEOUT_SEC)
            }) { resp -> explainText = resp.explanation }
        }
    }

    fun ask(document: String) {
        val q = question.trim()
        if (q.isEmpty()) return
        CoroutineScope(Dispatchers.Main).launch {
            run({
                ApiClient.post<AskResponse>(
                    Endpoint.READER_ASK,
                    buildJsonObject {
                        put("question", q)
                        put("document", document)
                    }, AppConfig.LLM_TIMEOUT_SEC)
            }) { resp -> answer = resp.answer ?: "" }
        }
    }

    /** 答题后鼓励式讲解 */
    fun grade(index: Int, picked: String, correct: String) {
        answers = answers + (index to picked)
        val right = picked == correct
        val qTitle = questions.getOrNull(index)?.question ?: ""
        val prompt = "这是一道阅读理解题。题目：$qTitle；正确答案：$correct；" +
            "学生选择：$picked；是否答对：${if (right) "对" else "错"}。请用一两句话给出鼓励式讲解。"
        CoroutineScope(Dispatchers.Main).launch {
            run({
                ApiClient.post<FeedbackResponse>(
                    Endpoint.READER_FEEDBACK,
                    buildJsonObject { put("text", prompt) }, AppConfig.LLM_TIMEOUT_SEC)
            }) { resp ->
                resp.feedback?.let { feedback = feedback + (index to it) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LearningPanel(content: String, title: String, onDismiss: () -> Unit) {
    val vm = remember { LearningViewModel() }

    LaunchedEffect(vm.mode) {
        if (content.isEmpty()) return@LaunchedEffect
        when {
            vm.mode == LearningViewModel.Mode.Quiz && vm.questions.isEmpty() -> vm.loadQuiz(content, false)
            vm.mode == LearningViewModel.Mode.Vocab && vm.words.isEmpty() -> vm.loadVocab(content)
            else -> {}
        }
    }

    // 全屏对话框（对应 iOS sheet）
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(Modifier.fillMaxSize()) {
            Column {
                TopAppBar(
                    title = { Text("学习 · $title", maxLines = 1) },
                    navigationIcon = { DetailNavBack(onDismiss) },
                    actions = { TextButton(onClick = onDismiss) { Text("完成") } },
                )
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    LearningViewModel.Mode.entries.forEach { m ->
                        FilterChip(
                            selected = vm.mode == m,
                            onClick = { vm.mode = m },
                            label = { Text(m.label) },
                        )
                    }
                }
                vm.errorMessage?.let {
                    Text(it, color = Color.Red, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp))
                }
                when (vm.mode) {
                    LearningViewModel.Mode.Quiz -> QuizList(vm, content)
                    LearningViewModel.Mode.Vocab -> VocabList(vm, content)
                    LearningViewModel.Mode.Ask -> AskView(vm, content)
                }
            }
        }
    }
}

@Composable
private fun QuizList(vm: LearningViewModel, document: String) {
    LazyColumn(Modifier.fillMaxSize()) {
        if (vm.busy && vm.questions.isEmpty()) {
            item { Row(Modifier.padding(16.dp)) { CircularProgressIndicator(Modifier.size(20.dp)); Text(" 出题中…") } }
        }
        items(vm.questions.size) { idx ->
            val q = vm.questions[idx]
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text("第 ${idx + 1} 题", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(q.question ?: "", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
                (q.options ?: emptyList()).forEach { opt ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { vm.grade(idx, opt, q.answer ?: "") }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(opt, Modifier.weight(1f))
                        if (vm.answers[idx] == opt) {
                            Text(
                                if (opt == q.answer) " ✔" else " ✘",
                                color = if (opt == q.answer) Color(0xFF2E7D32) else Color(0xFFC62828),
                            )
                        }
                    }
                }
                vm.feedback[idx]?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider(Modifier.padding(top = 8.dp))
            }
        }
        if (vm.questions.isNotEmpty()) {
            item {
                TextButton(onClick = { vm.loadQuiz(document, true) }, modifier = Modifier.padding(16.dp)) {
                    Text("换一组新题")
                }
            }
        }
    }
}

@Composable
private fun VocabList(vm: LearningViewModel, document: String) {
    LazyColumn(Modifier.fillMaxSize()) {
        if (vm.busy && vm.words.isEmpty()) {
            item { Row(Modifier.padding(16.dp)) { CircularProgressIndicator(Modifier.size(20.dp)); Text(" 选词中…") } }
        }
        items(vm.words) { w ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { vm.explain(w, document) }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(w, Modifier.weight(1f))
                Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider(Modifier.padding(horizontal = 16.dp))
        }
        vm.explainWord?.let { ew ->
            item {
                Column(Modifier.padding(16.dp)) {
                    Text("「$ew」讲解", fontWeight = FontWeight.SemiBold)
                    if (vm.busy && vm.explainText == null) {
                        CircularProgressIndicator(Modifier.padding(top = 8.dp).size(20.dp))
                    } else {
                        Text(vm.explainText ?: "（未生成）", modifier = Modifier.padding(top = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun AskView(vm: LearningViewModel, document: String) {
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = vm.question,
            onValueChange = { vm.question = it },
            placeholder = { Text("就本章内容提问…") },
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        )
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { vm.ask(document) },
                enabled = vm.question.isNotBlank() && !vm.busy,
            ) { Text("提问") }
            if (vm.busy) CircularProgressIndicator(Modifier.size(20.dp))
        }
        Box(
            Modifier
                .fillMaxSize()
                .padding(16.dp),
        ) {
            Text(
                if (vm.answer.isEmpty()) "提问后，AI 会依据本章内容作答。" else vm.answer,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
