package jp.co.fsr.ainovel.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.TextFormat
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.co.fsr.ainovel.AppConfig
import jp.co.fsr.ainovel.TtsPlayer
import jp.co.fsr.ainovel.data.Chapter
import jp.co.fsr.ainovel.data.ChapterDetail
import jp.co.fsr.ainovel.data.ChapterResponse
import jp.co.fsr.ainovel.data.ChaptersResponse
import jp.co.fsr.ainovel.data.Novel
import jp.co.fsr.ainovel.data.NovelsResponse
import jp.co.fsr.ainovel.data.ShareResponse
import jp.co.fsr.ainovel.net.ApiClient
import jp.co.fsr.ainovel.net.Endpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** 小说清单共享 ViewModel：阅读 Tab 与管理 Tab 都用它拉 /api/novels。 */
class LibraryViewModel {
    var novels by mutableStateOf<List<Novel>>(emptyList())
        private set
    var loading by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    /** 超管可切换"查看全部作品" */
    var showAll by mutableStateOf(false)

    fun refresh() {
        CoroutineScope(Dispatchers.Main).launch {
            loading = true
            errorMessage = null
            try {
                val query = if (showAll) mapOf("all" to "1") else null
                novels = ApiClient.get<NovelsResponse>(Endpoint.NOVELS, query).novels ?: emptyList()
            } catch (e: Exception) {
                errorMessage = e.message
            }
            loading = false
        }
    }

    fun novel(id: String?): Novel? = novels.firstOrNull { it.id == id }
}

/** 阅读 Tab 根：登录用户自己的作品列表 → 章节 → 原生阅读。 */
@Composable
fun ReaderHomeScreen(lib: LibraryViewModel, onOpenNovel: (Novel) -> Unit) {
    var search by remember { mutableStateOf("") }
    val filtered = if (search.isEmpty()) lib.novels else lib.novels.filter { (it.name ?: "").contains(search) }

    LaunchedEffect(Unit) { if (lib.novels.isEmpty()) lib.refresh() }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = search,
            onValueChange = { search = it },
            placeholder = { Text("搜索书名") },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )
        Box(Modifier.fillMaxSize()) {
            when {
                lib.loading && lib.novels.isEmpty() -> LoadingView()
                lib.errorMessage != null -> StateView(
                    title = "加载失败",
                    description = lib.errorMessage,
                    actionLabel = "重试",
                    onAction = { lib.refresh() },
                )
                filtered.isEmpty() -> StateView(
                    title = "暂无作品",
                    description = "在「管理」Tab 新建小说并生成章节后，这里就能看到。",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(filtered, key = { it.id ?: it.display }) { novel ->
                        NovelRow(novel)
                        HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun NovelRow(novel: Novel, onClick: (() -> Unit)? = null, onDelete: (() -> Unit)? = null) {
    Surface(
        color = Color.Transparent,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick?.invoke() },
    ) {
        Row(
            Modifier
                .padding(horizontal = 16.dp, vertical = 10.dp)
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(novel.display, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (novel.vip == true) {
                        Surface(
                            shape = MaterialTheme.shapes.extraLarge,
                            color = Color(0x33FF9800),
                            modifier = Modifier.padding(start = 6.dp),
                        ) {
                            Text("VIP", fontSize = 10.sp, color = Color(0xFFFF9800), modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                        }
                    }
                }
                Text(novel.chaptersDesc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (onDelete != null) {
                TextButton(onClick = onDelete) { Text("删除", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/** 章节列表 ViewModel：只显示有正文的章。 */
class ChapterListViewModel {
    var chapters by mutableStateOf<List<Chapter>>(emptyList())
        private set
    var totalWords by mutableStateOf(0)
    var loading by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    fun load(novelId: String?) {
        if (novelId == null) return
        CoroutineScope(Dispatchers.Main).launch {
            loading = true
            errorMessage = null
            try {
                val resp = ApiClient.get<ChaptersResponse>(Endpoint.chapters(novelId))
                // 只显示有正文的章（无正文的章读者看不到）
                chapters = (resp.chapters ?: emptyList()).filter { it.hasContent == true }
                totalWords = resp.totalWords ?: 0
            } catch (e: Exception) {
                errorMessage = e.message
            }
            loading = false
        }
    }
}

@Composable
fun ChapterListScreen(
    novelId: String,
    novelName: String,
    onBack: () -> Unit,
    onOpenChapter: (List<Chapter>, Int) -> Unit,
) {
    val vm = remember { ChapterListViewModel() }
    LaunchedEffect(novelId) { vm.load(novelId) }

    Column(Modifier.fillMaxSize()) {
        DetailTopBar(title = novelName, onBack = onBack)
        Box(Modifier.fillMaxSize()) {
            when {
                vm.loading && vm.chapters.isEmpty() -> LoadingView("加载目录…")
                vm.errorMessage != null -> StateView("加载失败", vm.errorMessage)
                vm.chapters.isEmpty() -> StateView("暂无已发布正文", "这本书还没有生成章节正文。")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Text(
                            "$novelName · 共 ${vm.chapters.size} 章 · 正文 ${vm.totalWords} 字",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                        HorizontalDivider()
                    }
                    items(vm.chapters, key = { "${it.no}-${it.id}" }) { ch ->
                        val idx = vm.chapters.indexOf(ch)
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { onOpenChapter(vm.chapters, idx) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Column {
                                Text(ch.display, style = MaterialTheme.typography.bodyLarge)
                                Text(ch.wordsDesc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    }
                }
            }
        }
    }
}

/** 阅读器 ViewModel：章节正文 + 发布页入口。 */
class ReaderViewModel {
    var detail by mutableStateOf<ChapterDetail?>(null)
        private set
    var share by mutableStateOf<ShareResponse?>(null)
    var loading by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    fun load(novelId: String?, no: Int?) {
        if (novelId == null || no == null) return
        CoroutineScope(Dispatchers.Main).launch {
            loading = true
            errorMessage = null
            try {
                detail = ApiClient.get<ChapterResponse>(Endpoint.chapter(novelId, no)).chapter
            } catch (e: Exception) {
                errorMessage = e.message
            }
            loading = false
        }
    }

    /** 拉发布页入口（/share），用于「直接观看」拼出真实书页 URL */
    fun loadShare(novelId: String?) {
        if (novelId == null || share != null) return
        CoroutineScope(Dispatchers.Main).launch {
            share = runCatching { ApiClient.get<ShareResponse>(Endpoint.share(novelId)) }.getOrNull()
        }
    }

    /** 当前章的发布页地址：share.url 的 index.html 换成 chapter_<章id>.html（发布文件名吃稳定章节 id） */
    fun publishedChapterURL(chapterId: String?): String? {
        val base = share?.url ?: return null
        val cid = chapterId ?: return null
        val dir = base.removeSuffix("index.html")
        return SiteUrls.relativeURL(dir + "chapter_$cid.html")
    }
}

/** 阅读器：正文渲染 + 底部翻章/朗读条 + 顶部（网页/学习/字号）。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderScreen(
    novel: Novel,
    chapters: List<Chapter>,
    startIndex: Int,
    onBack: () -> Unit,
) {
    val vm = remember { ReaderViewModel() }
    val tts = remember { TtsPlayer(AppConfig.appContext) }
    var index by remember { mutableStateOf(startIndex) }
    var showLearning by remember { mutableStateOf(false) }
    var showFontSheet by remember { mutableStateOf(false) }
    var siteUrl by remember { mutableStateOf<String?>(null) }
    var siteNotPublished by remember { mutableStateOf(false) }
    val prefs = remember { AppConfig.appContext.getSharedPreferences("reader", android.content.Context.MODE_PRIVATE) }
    var fontSize by remember { mutableStateOf(prefs.getFloat("readerFontSize", 18f)) }

    LaunchedEffect(Unit) { vm.loadShare(novel.id) }
    LaunchedEffect(index) {
        val ch = chapters.getOrNull(index)
        vm.load(novel.id, ch?.no)
    }
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose { tts.stop(); tts.shutdown() }
    }

    fun openPublishedSite() {
        val sh = vm.share
        if (sh?.published != true) {
            siteNotPublished = true
            return
        }
        val chapterId = chapters.getOrNull(index)?.id
        val u = vm.publishedChapterURL(chapterId) ?: SiteUrls.relativeURL(sh.url ?: "")
        if (u != null) siteUrl = u else siteNotPublished = true
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(novel.display, maxLines = 1) },
            navigationIcon = { DetailNavBack(onBack) },
            actions = {
                IconButton(onClick = { openPublishedSite() }) { Icon(Icons.Filled.Language, contentDescription = "直接观看") }
                IconButton(onClick = { showLearning = true }) { Icon(Icons.Filled.School, contentDescription = "学习") }
                IconButton(onClick = { showFontSheet = true }) { Icon(Icons.Filled.TextFormat, contentDescription = "字号") }
            },
        )
        Box(Modifier.weight(1f)) {
            val d = vm.detail
            when {
                d == null && vm.loading -> LoadingView("加载正文…")
                d == null && vm.errorMessage != null -> StateView("加载失败", vm.errorMessage, "重试") { vm.load(novel.id, chapters.getOrNull(index)?.no) }
                d != null -> Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    d.name?.let { Text(it, fontSize = 22.sp, fontWeight = FontWeight.Bold) }
                    Text(
                        "第 ${d.no ?: 0} 章 · ${d.wordCount ?: 0} 字",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    HorizontalDivider(Modifier.padding(vertical = 12.dp))
                    Text(
                        d.content ?: "",
                        fontSize = fontSize.sp,
                        lineHeight = (fontSize * 1.6f).sp,
                        textAlign = TextAlign.Justify,
                    )
                    Spacer(Modifier.size(24.dp))
                }
            }
        }
        // 底部翻章/朗读条
        Surface(tonalElevation = 3.dp) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = {
                    tts.stop()
                    if (index > 0) index -= 1
                }, enabled = index > 0) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "上一章")
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = {
                    if (tts.speaking) tts.stop() else tts.start(vm.detail?.content ?: "")
                }) {
                    if (tts.speaking) {
                        Icon(Icons.Filled.Stop, contentDescription = "停止朗读", modifier = Modifier.size(32.dp))
                    } else {
                        Icon(Icons.Filled.PlayArrow, contentDescription = "朗读", modifier = Modifier.size(32.dp))
                    }
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = {
                    tts.stop()
                    if (index < chapters.size - 1) index += 1
                }, enabled = index < chapters.size - 1) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "下一章")
                }
            }
        }
    }

    if (showLearning) {
        LearningPanel(
            content = vm.detail?.content ?: "",
            title = vm.detail?.name ?: novel.display,
            onDismiss = { showLearning = false },
        )
    }

    if (showFontSheet) {
        Dialog(onDismissRequest = { showFontSheet = false }) {
            Surface(shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(20.dp)) {
                    Text("字号 ${fontSize.toInt()}", style = MaterialTheme.typography.titleMedium)
                    Slider(
                        value = fontSize,
                        onValueChange = { fontSize = it },
                        onValueChangeFinished = { prefs.edit().putFloat("readerFontSize", fontSize).apply() },
                        valueRange = 14f..28f,
                        steps = 13,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }
    }

    siteUrl?.let { u ->
        SiteWebPage(url = u, title = vm.detail?.name ?: novel.display, onDismiss = { siteUrl = null })
    }

    if (siteNotPublished) {
        AlertDialog(
            onDismissRequest = { siteNotPublished = false },
            title = { Text("本书尚未发布") },
            text = { Text("发布后才能直接观看读者站页面。可在「管理」Tab 发布。") },
            confirmButton = { TextButton(onClick = { siteNotPublished = false }) { Text("好") } },
        )
    }
}

/** 顶栏通用返回按钮与详情页顶栏（各详情页共用） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailNavBack(onBack: () -> Unit) {
    IconButton(onClick = onBack) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailTopBar(title: String, onBack: () -> Unit) {
    TopAppBar(title = { Text(title, maxLines = 1) }, navigationIcon = { DetailNavBack(onBack) })
}
