package jp.co.fsr.ainovel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import jp.co.fsr.ainovel.AppConfig
import jp.co.fsr.ainovel.data.Chapter
import jp.co.fsr.ainovel.data.ChaptersResponse
import jp.co.fsr.ainovel.data.CreateNovelResponse
import jp.co.fsr.ainovel.data.GenCfg
import jp.co.fsr.ainovel.data.Novel
import jp.co.fsr.ainovel.data.NovelSettings
import jp.co.fsr.ainovel.data.OutlineDraft
import jp.co.fsr.ainovel.data.PartsResponse
import jp.co.fsr.ainovel.data.RenumberResponse
import jp.co.fsr.ainovel.data.SaveSettingsResponse
import jp.co.fsr.ainovel.data.ShareResponse
import jp.co.fsr.ainovel.data.VipResponse
import jp.co.fsr.ainovel.data.OkResponse
import jp.co.fsr.ainovel.data.PublishResponse
import jp.co.fsr.ainovel.data.RunResponse
import jp.co.fsr.ainovel.net.ApiClient
import jp.co.fsr.ainovel.net.Endpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 管理 Tab 根：作品列表 + 新建 + 删除（输入 OK 确认）。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageHomeScreen(lib: LibraryViewModel, onOpenNovel: (Novel) -> Unit) {
    var showCreate by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<Novel?>(null) }

    LaunchedEffect(Unit) { if (lib.novels.isEmpty()) lib.refresh() }

    Scaffold(
        topBar = { DetailTopBarStatic("管理") },
        floatingActionButton = {
            FloatingActionButton(onClick = { showCreate = true }) {
                Icon(Icons.Filled.Add, contentDescription = "新建")
            }
        },
    ) { padding ->
        Box(Modifier
            .fillMaxSize()
            .padding(padding)) {
            when {
                lib.loading && lib.novels.isEmpty() -> LoadingView()
                lib.errorMessage != null -> StateView("加载失败", lib.errorMessage, "重试") { lib.refresh() }
                lib.novels.isEmpty() -> StateView("还没有作品", "点右下角「＋」新建一本小说")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(lib.novels.size) { i ->
                        val novel = lib.novels[i]
                        NovelRow(
                            novel,
                            onClick = { onOpenNovel(novel) },
                            onDelete = { pendingDelete = novel },
                        )
                        HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    }
                }
            }
        }
    }

    if (showCreate) {
        NovelCreateDialog(
            onDismiss = { showCreate = false },
            onCreated = { lib.refresh() },
        )
    }

    pendingDelete?.let { novel ->
        DeleteNovelDialog(
            novel = novel,
            onDismiss = { pendingDelete = null },
            onConfirm = {
                CoroutineScope(Dispatchers.Main).launch {
                    try {
                        ApiClient.delete<OkResponse>(
                            Endpoint.novel(novel.id ?: ""),
                            buildJsonObject { put("confirm", "OK") })
                        pendingDelete = null
                        lib.refresh()
                    } catch (e: Exception) {
                        lib.errorMessage = e.message
                    }
                }
            },
        )
    }
}

/** 无返回键的 Tab 顶栏 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailTopBarStatic(title: String, actions: @Composable () -> Unit = {}) {
    androidx.compose.material3.TopAppBar(
        title = { Text(title) },
        actions = { actions() },
    )
}

@Composable
private fun DeleteNovelDialog(novel: Novel, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除整本小说") },
        text = {
            Column {
                Text("删除《${novel.display}》及其全部章节，不可撤销。请输入大写 OK 确认。")
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("输入 OK 以确认删除") },
                    singleLine = true,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = text.trim() == "OK",
            ) { Text("删除", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun NovelCreateDialog(onDismiss: () -> Unit, onCreated: () -> Unit) {
    var title by remember { mutableStateOf("") }
    var outline by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建小说") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("书名", style = MaterialTheme.typography.labelLarge)
                OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true, placeholder = { Text("必填") })
                Text("故事概要", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp))
                OutlinedTextField(
                    value = outline,
                    onValueChange = { outline = it },
                    placeholder = { Text("全书主线，用于后续大纲/正文生成的上下文") },
                    modifier = Modifier.fillMaxWidth(),
                )
                err?.let { Text(it, color = Color.Red, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = title.isNotBlank() && !busy,
                onClick = {
                    err = null
                    busy = true
                    CoroutineScope(Dispatchers.Main).launch {
                        try {
                            ApiClient.post<CreateNovelResponse>(
                                Endpoint.NOVELS,
                                buildJsonObject {
                                    put("title", title)
                                    put("outline", outline)
                                })
                            onCreated()
                            onDismiss()
                        } catch (e: Exception) {
                            err = e.message
                        }
                        busy = false
                    }
                },
            ) { Text(if (busy) "创建中…" else "创建") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 单本小说的管理 ViewModel：设定读写、章节列表、大纲编辑、生成动作、发布、VIP、分享。 */
class NovelManageViewModel(val novelId: String) {
    var settings by mutableStateOf<NovelSettings?>(null)
        private set
    var chapters by mutableStateOf<List<Chapter>>(emptyList())
        private set
    var share by mutableStateOf<ShareResponse?>(null)
        private set
    var vip by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var busyAction by mutableStateOf<String?>(null)
    var errorMessage by mutableStateOf<String?>(null)
    var infoMessage by mutableStateOf<String?>(null)

    fun loadAll() {
        loading = true
        CoroutineScope(Dispatchers.Main).launch {
            val jobs = listOf(
                launch { loadSettings() },
                launch { loadChapters() },
                launch { loadShare() },
                launch { loadVip() },
            )
            jobs.forEach { it.join() }
            loading = false
        }
    }

    private suspend fun loadSettings() {
        try { settings = ApiClient.get<NovelSettings>(Endpoint.settings(novelId)) }
        catch (e: Exception) { errorMessage = e.message }
    }

    private suspend fun loadChapters() {
        try {
            chapters = ApiClient.get<ChaptersResponse>(Endpoint.chapters(novelId)).chapters ?: emptyList()
        } catch (e: Exception) { errorMessage = e.message }
    }

    private suspend fun loadShare() {
        try { share = ApiClient.get<ShareResponse>(Endpoint.share(novelId)) }
        catch (e: Exception) { errorMessage = e.message }
    }

    private suspend fun loadVip() {
        // VIP 为可选配置，读不到不阻断
        vip = runCatching { ApiClient.get<VipResponse>(Endpoint.vip(novelId)).vip ?: false }.getOrDefault(false)
    }

    private suspend fun loadPartsInternal() {
        // 分部为可选，读不到不阻断（当前界面未展示，保留与 iOS 一致的加载）
        runCatching { ApiClient.get<PartsResponse>(Endpoint.parts(novelId)) }
    }

    /** 设定保存（未传即不改） */
    fun saveSettings(name: String, outline: String, content: String, genCfg: GenCfg?) {
        busy("保存设定") {
            val body = buildJsonObject {
                put("name", name)
                put("outline", outline)
                put("content", content)
                if (genCfg != null) {
                    val cfg = genCfg
                    put(
                        "genCfg",
                        buildJsonObject {
                            cfg.targetWords?.let { put("targetWords", it) }
                            cfg.tolerancePct?.let { put("tolerancePct", it) }
                            cfg.splitPct?.let { put("splitPct", it) }
                        })
                }
            }
            ApiClient.put<SaveSettingsResponse>(Endpoint.settings(novelId), body)
            loadSettings()
            infoMessage = "设定已保存"
        }
    }

    fun saveOutline(no: Int, name: String?, outline: String?) {
        busy("保存大纲") {
            val body = buildJsonObject {
                if (name != null) put("name", name)
                if (outline != null) put("outline", outline)
            }
            ApiClient.put<OkResponse>(Endpoint.outline(novelId, no), body)
            loadChapters()
            infoMessage = "第 $no 章大纲已保存"
        }
    }

    /** 就地生成大纲草稿（只读、不落库），返回 {name, outline} */
    suspend fun outlineDraft(no: Int, material: String): Pair<String, String>? {
        busyAction = "生成大纲草稿"
        errorMessage = null
        return try {
            val d = ApiClient.post<OutlineDraft>(
                Endpoint.outlineDraft(novelId, no),
                buildJsonObject { put("material", material) },
                AppConfig.LLM_TIMEOUT_SEC,
            )
            (d.name ?: "") to (d.outline ?: "")
        } catch (e: Exception) {
            errorMessage = e.message
            null
        } finally {
            busyAction = null
        }
    }

    /** 生成动作走通用 /api/run（长任务，超时放宽到 llmTimeout） */
    fun runAction(action: String) {
        busy(action) {
            val resp = ApiClient.post<RunResponse>(
                Endpoint.RUN,
                buildJsonObject {
                    put("action", action)
                    put("novelId", novelId)
                },
                AppConfig.LLM_TIMEOUT_SEC,
            )
            if (resp.success == true) {
                loadChapters()
                infoMessage = "「$action」完成"
            } else {
                resp.resultText?.let { infoMessage = it }
            }
        }
    }

    fun publish(premake: Boolean) {
        busy("发布") {
            val resp = ApiClient.post<PublishResponse>(
                Endpoint.publish(novelId),
                buildJsonObject { put("premakeQuiz", premake) },
                AppConfig.LLM_TIMEOUT_SEC,
            )
            loadShare()
            infoMessage = "发布完成：${resp.pages ?: 0} 页"
        }
    }

    fun renumber() {
        busy("重排编号") {
            val resp = ApiClient.put<RenumberResponse>(Endpoint.renumber(novelId), buildJsonObject { })
            loadChapters()
            infoMessage = "已顺延 ${resp.shiftedCount ?: 0} 章"
        }
    }

    fun deleteChapter(no: Int) {
        busy("删除第 $no 章") {
            ApiClient.delete<OkResponse>(
                Endpoint.deleteChapter(novelId, no),
                buildJsonObject { put("confirm", "OK") })
            loadChapters()
            infoMessage = "已删除第 $no 章"
        }
    }

    fun toggleVip(on: Boolean) {
        busy(if (on) "开启 VIP" else "关闭 VIP") {
            val resp = ApiClient.put<VipResponse>(Endpoint.vip(novelId), buildJsonObject { put("vip", on) })
            vip = resp.vip ?: on
        }
    }

    fun clearInfo() { infoMessage = null }

    /** busy 包裹的挂起任务（在 Main 协程内执行 work） */
    private fun busy(label: String, work: suspend () -> Unit) {
        busyAction = label
        errorMessage = null
        CoroutineScope(Dispatchers.Main).launch {
            try {
                work()
            } catch (e: Exception) {
                errorMessage = e.message
            }
            busyAction = null
        }
    }
}

/** 小说管理页：状态 / 生成动作 / 章节 / 发布四个区。 */
@Composable
fun NovelManageScreen(novelId: String, novelName: String, onBack: () -> Unit) {
    val vm = remember { NovelManageViewModel(novelId) }
    var showSettings by remember { mutableStateOf(false) }
    var editChapter by remember { mutableStateOf<Chapter?>(null) }
    var premakeQuiz by remember { mutableStateOf(true) }
    var siteUrl by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.loadAll() }
    // info 横幅 3 秒自动消失（对应 iOS banner）
    LaunchedEffect(vm.infoMessage) {
        if (vm.infoMessage != null) {
            kotlinx.coroutines.delay(3000)
            vm.clearInfo()
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(novelName, onBack)
            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // 状态
                SectionTitle("状态")
                val s = vm.settings
                if (s != null) {
                    LabelValue("章节", "${s.chapterCount ?: 0} 章")
                    LabelValue("已生成正文", "${s.bodyCount ?: 0} 章")
                    LabelValue("全书字数", "${s.totalWords ?: 0} 字")
                    LabelValue("字数区间", s.wordBandText ?: "未设定")
                    TextButton(onClick = { showSettings = true }) { Text("编辑设定（书名/概要/字数）") }
                } else {
                    Text("载入中…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                // 生成
                SectionTitle("生成（需推理链路绿灯，耗时较长）")
                TextButton(onClick = { vm.runAction("generateChapterOutlines") }) { Text("🧭 生成/重建全部大纲") }
                TextButton(onClick = { vm.runAction("generate") }) { Text("✍️ 补写缺失正文") }
                TextButton(onClick = { vm.renumber() }) { Text("🔢 重排章节编号") }
                Text(
                    "大纲重建会清空命中章的正文；正文补写只处理大纲非空、正文为空的章。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // 章节
                SectionTitle("章节（${vm.chapters.size}）")
                vm.chapters.forEach { ch ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { editChapter = ch }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(ch.display, color = MaterialTheme.colorScheme.onSurface)
                            Text(
                                "大纲 ${ch.outline?.length ?: 0} 字 · 正文 ${ch.wordsDesc}",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (ch.hasContent == true) Text("✅")
                        ch.no?.let { no ->
                            IconButton(onClick = { vm.deleteChapter(no) }) {
                                Text("🗑", fontSize = 16.sp)
                            }
                        }
                    }
                    HorizontalDivider()
                }

                // 发布 / VIP
                SectionTitle("发布")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = premakeQuiz, onCheckedChange = { premakeQuiz = it })
                    Text(" 发布时预生成测试题与生词表", fontSize = 14.sp)
                }
                TextButton(onClick = { vm.publish(premakeQuiz) }) { Text("🚀 发布到读者站") }
                vm.share?.let { sh ->
                    LabelValue("线上", if (sh.published == true) "已发布" else "未发布")
                    if (sh.published == true && sh.url != null) {
                        TextButton(onClick = { siteUrl = SiteUrls.relativeURL(sh.url) }) { Text("📖 直接观看") }
                    } else {
                        Text("尚未发布，无法直接观看", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = vm.vip, onCheckedChange = { vm.toggleVip(it) })
                    Text(" 本书为 VIP 专属", fontSize = 14.sp)
                }
                Spacer(Modifier.size(24.dp))
            }
            // 底部错误/信息横幅
            when {
                vm.errorMessage != null -> Banner(vm.errorMessage!!, Color(0xFFC62828))
                vm.infoMessage != null -> Banner(vm.infoMessage!!, Color(0xFF2E7D32))
            }
        }

        // 长任务遮罩
        vm.busyAction?.let { label ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Card(elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)) {
                    Column(
                        Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                        Text(label, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
                        Text("长任务进行中，请勿关闭…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }

    if (showSettings) {
        NovelSettingsDialog(vm, onDismiss = { showSettings = false })
    }

    editChapter?.let { ch ->
        ChapterOutlineDialog(vm, ch, onDismiss = { editChapter = null })
    }

    siteUrl?.let { u ->
        SiteWebPage(url = u, title = novelName, onDismiss = { siteUrl = null })
    }
}

@Composable
private fun LabelValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, fontSize = 14.sp)
    }
}

@Composable
private fun Banner(msg: String, bg: Color) {
    Box(Modifier.fillMaxWidth().background(bg)) {
        Text(msg, color = Color.White, fontSize = 12.sp, modifier = Modifier.padding(10.dp))
    }
}

/** 小说设定弹层：书名 / 故事概要 / 正文设定 + 每章字数（genCfg）。留空即不改动该项。 */
@Composable
private fun NovelSettingsDialog(vm: NovelManageViewModel, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(vm.settings?.name ?: "") }
    var outline by remember { mutableStateOf(vm.settings?.outline ?: "") }
    var content by remember { mutableStateOf(vm.settings?.content ?: "") }
    var targetWords by remember { mutableStateOf(vm.settings?.genCfg?.targetWords?.toString() ?: "") }
    var tolerancePct by remember { mutableStateOf(vm.settings?.genCfg?.tolerancePct?.toString() ?: "") }
    var splitPct by remember { mutableStateOf(vm.settings?.genCfg?.splitPct?.toString() ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("小说设定") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Field("书名", name) { name = it }
                Field("故事概要", outline, "全书主线") { outline = it }
                Field("设定正文（角色 / 世界观）", content, "世界观、角色设定等") { content = it }
                Text("每章字数设定（留空即不改动。合格带 = 目标 ×(1±浮动%)）", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp))
                Field("目标字数（0=不限）", targetWords) { targetWords = it }
                Field("浮动比例 %（5-50）", tolerancePct) { tolerancePct = it }
                Field("拆章线 %（20-300）", splitPct) { splitPct = it }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && vm.busyAction == null,
                onClick = {
                    val cfg = GenCfg(
                        targetWords = targetWords.toIntOrNull(),
                        tolerancePct = tolerancePct.toIntOrNull(),
                        splitPct = splitPct.toIntOrNull(),
                    )
                    val anyCfg = cfg.targetWords != null || cfg.tolerancePct != null || cfg.splitPct != null
                    vm.saveSettings(name, outline, content, if (anyCfg) cfg else null)
                    onDismiss()
                },
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun Field(label: String, value: String, placeholder: String = "", onValueChange: (String) -> Unit) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        OutlinedTextField(value = value, onValueChange = onValueChange, placeholder = { Text(placeholder) }, modifier = Modifier.fillMaxWidth())
    }
}

/** 单章标题 / 大纲编辑弹层：手改或"填构思 → 就地生成草稿 → 改完保存"。 */
@Composable
private fun ChapterOutlineDialog(vm: NovelManageViewModel, chapter: Chapter, onDismiss: () -> Unit) {
    var title by remember { mutableStateOf(chapter.name ?: "") }
    var outline by remember { mutableStateOf(chapter.outline ?: "") }
    var material by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("第 ${chapter.no ?: 0} 章") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Field("章节标题", title) { title = it }
                Field("本章构思（可留空，留空则据全书概要与前后章衔接）", material, "这章要写什么") { material = it }
                TextButton(
                    enabled = vm.busyAction == null &&
                        (material.isNotEmpty() || (vm.settings?.outline?.isNotEmpty() == true)),
                    onClick = {
                        status = "生成中…"
                        CoroutineScope(Dispatchers.Main).launch {
                            val no = chapter.no ?: 0
                            val d = vm.outlineDraft(no, material)
                            status = if (d != null) {
                                if (d.second.isNotEmpty()) outline = d.second
                                if (d.first.isNotEmpty() && title.isEmpty()) title = d.first
                                if (d.second.isEmpty()) "模型未返回可用大纲" else "草稿已填入，可修改后保存"
                            } else {
                                "生成失败：${vm.errorMessage ?: "未知错误"}"
                            }
                        }
                    },
                ) {
                    if (vm.busyAction != null) {
                        CircularProgressIndicator(Modifier.size(16.dp))
                        Text(" 生成中（一次模型调用，可能一分多钟）")
                    } else {
                        Text("🧭 生成大纲草稿")
                    }
                }
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text("章节大纲", style = MaterialTheme.typography.labelMedium)
                    OutlinedTextField(
                        value = outline,
                        onValueChange = { outline = it },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(160.dp),
                    )
                }
                status?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = vm.busyAction == null,
                onClick = {
                    vm.saveOutline(chapter.no ?: 0, title, outline)
                    onDismiss()
                },
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
