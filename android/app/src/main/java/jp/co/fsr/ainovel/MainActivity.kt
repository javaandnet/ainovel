@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package jp.co.fsr.ainovel

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import jp.co.fsr.ainovel.data.Chapter
import jp.co.fsr.ainovel.data.Novel
import jp.co.fsr.ainovel.ui.AINovelTheme
import jp.co.fsr.ainovel.ui.ChapterListScreen
import jp.co.fsr.ainovel.ui.LoadingView
import jp.co.fsr.ainovel.ui.LibraryViewModel
import jp.co.fsr.ainovel.ui.LoginContent
import jp.co.fsr.ainovel.ui.ManageHomeScreen
import jp.co.fsr.ainovel.ui.MeScreen
import jp.co.fsr.ainovel.ui.NovelManageScreen
import jp.co.fsr.ainovel.ui.ReaderHomeScreen
import jp.co.fsr.ainovel.ui.ReaderScreen

/**
 * 入口与路由。三 Tab（阅读/管理/我的）+ 深层页面（章节目录 → 阅读器；作品管理）。
 * 登录以全屏弹层呈现（对应 iOS RootView 的 sheet）：未登录也可进入浏览公开书单。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppConfig.appContext = applicationContext
        setContent {
            AINovelTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    RootView()
                }
            }
        }
    }
}

private object Routes {
    const val READER = "reader"
    const val MANAGE = "manage"
    const val ME = "me"
    const val CHAPTERS = "reader/chapters/{novelId}/{novelName}"
    const val READING = "reader/reading/{novelId}/{no}/{novelName}"
    const val NOVEL_MANAGE = "manage/novel/{novelId}/{novelName}"

    fun chapters(novel: Novel) = "reader/chapters/${novel.id}/${android.net.Uri.encode(novel.display)}"
    fun reading(novel: Novel, no: Int) =
        "reader/reading/${novel.id}/$no/${android.net.Uri.encode(novel.display)}"

    fun manage(novel: Novel) = "manage/novel/${novel.id}/${android.net.Uri.encode(novel.display)}"
}

@Composable
fun RootView() {
    val nav: NavHostController = rememberNavController()
    var lib by remember { mutableStateOf(LibraryViewModel()) }

    // 冷启动：探 /api/me 确认 Cookie 是否仍有效
    LaunchedEffect(Unit) {
        if (AuthState.bootstrapping) AuthState.bootstrap()
    }

    if (AuthState.bootstrapping) {
        LoadingView()
        return
    }

    val backStackEntry by nav.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val showTabs = currentRoute == Routes.READER || currentRoute == Routes.MANAGE || currentRoute == Routes.ME

    Scaffold(
        bottomBar = {
            if (showTabs) {
                NavigationBar {
                    NavigationBarItem(
                        selected = currentRoute == Routes.READER,
                        onClick = { nav.navigate(Routes.READER) { popUpTo(Routes.READER); launchSingleTop = true } },
                        icon = { Icon(Icons.Filled.MenuBook, contentDescription = null) },
                        label = { Text("阅读") },
                    )
                    NavigationBarItem(
                        selected = currentRoute == Routes.MANAGE,
                        onClick = { nav.navigate(Routes.MANAGE) { popUpTo(Routes.READER); launchSingleTop = true } },
                        icon = { Icon(Icons.Filled.Tune, contentDescription = null) },
                        label = { Text("管理") },
                    )
                    NavigationBarItem(
                        selected = currentRoute == Routes.ME,
                        onClick = { nav.navigate(Routes.ME) { popUpTo(Routes.READER); launchSingleTop = true } },
                        icon = { Icon(Icons.Filled.Person, contentDescription = null) },
                        label = { Text("我的") },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier
            .fillMaxSize()
            .padding(padding)) {
            NavHost(navController = nav, startDestination = Routes.READER) {
                composable(Routes.READER) {
                    ReaderHomeScreen(lib, onOpenNovel = { nav.navigate(Routes.chapters(it)) })
                }
                composable(Routes.CHAPTERS) { entry ->
                    val novelId = entry.arguments?.getString("novelId") ?: ""
                    val novelName = entry.arguments?.getString("novelName") ?: ""
                    ChapterListScreen(
                        novelId = novelId,
                        novelName = novelName,
                        onBack = { nav.popBackStack() },
                        onOpenChapter = { chapters: List<Chapter>, idx: Int ->
                            val ch = chapters.getOrNull(idx) ?: return@ChapterListScreen
                            nav.navigate(Routes.reading(lib.novel(novelId) ?: fallbackNovel(novelId, novelName), ch.no ?: 1))
                        },
                    )
                }
                composable(Routes.READING) { entry ->
                    val novelId = entry.arguments?.getString("novelId") ?: ""
                    val novelName = entry.arguments?.getString("novelName") ?: ""
                    val no = entry.arguments?.getInt("no") ?: 1
                    ReaderRoute(novelId, novelName, no, onBack = { nav.popBackStack() })
                }
                composable(Routes.MANAGE) {
                    ManageHomeScreen(lib, onOpenNovel = { nav.navigate(Routes.manage(it)) })
                }
                composable(Routes.NOVEL_MANAGE) { entry ->
                    NovelManageScreen(
                        novelId = entry.arguments?.getString("novelId") ?: "",
                        novelName = entry.arguments?.getString("novelName") ?: "",
                        onBack = { nav.popBackStack() },
                    )
                }
                composable(Routes.ME) { MeScreen() }
            }
        }
    }

    // 按需登录弹层：未登录可浏览公开列表，遇到需登录的操作（点开章节 401 / 手动登录）时拉起
    if (AuthState.showLogin) {
        Dialog(
            onDismissRequest = { AuthState.showLogin = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize()) {
                Column {
                    androidx.compose.material3.TopAppBar(
                        title = { Text("AI小说 · 登录") },
                        navigationIcon = {
                            TextButton(onClick = { AuthState.showLogin = false }) { Text("以后再说") }
                        },
                    )
                    LoginContent(onLoggedIn = { AuthState.showLogin = false })
                }
            }
        }
    }
}

private fun fallbackNovel(id: String, name: String): Novel =
    Novel(id = id, name = name)

/** 阅读器路由包装：章节目录传入章序号，进入后重新拉目录以支持前后翻章。 */
@Composable
private fun ReaderRoute(novelId: String, novelName: String, startNo: Int, onBack: () -> Unit) {
    var state by remember { mutableStateOf<Pair<Novel, List<Chapter>>?>(null) }
    LaunchedEffect(novelId) {
        try {
            val resp = jp.co.fsr.ainovel.net.ApiClient.get<jp.co.fsr.ainovel.data.ChaptersResponse>(
                jp.co.fsr.ainovel.net.Endpoint.chapters(novelId))
            val visible = (resp.chapters ?: emptyList()).filter { it.hasContent == true }
            state = fallbackNovel(novelId, novelName) to visible
        } catch (e: Exception) {
            state = fallbackNovel(novelId, novelName) to emptyList()
        }
    }
    val pair = state
    if (pair == null) {
        LoadingView("加载目录…")
        return
    }
    val startIndex = pair.second.indexOfFirst { it.no == startNo }.coerceAtLeast(0)
    ReaderScreen(novel = pair.first, chapters = pair.second, startIndex = startIndex, onBack = onBack)
}
