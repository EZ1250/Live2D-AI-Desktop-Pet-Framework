package com.pet.mcpclient

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pet.mcpclient.ui.AppViewModel
import com.pet.mcpclient.ui.PetMcpApp
import com.pet.mcpclient.ui.PetMcpTheme

class MainActivity : ComponentActivity() {
    private var appVm: AppViewModel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PetMcpTheme {
                val vm = viewModel<AppViewModel>()
                appVm = vm
                PetMcpApp(vm)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        appVm?.onAppForeground()
    }

    override fun onStop() {
        appVm?.onAppBackground()
        super.onStop()
    }
}
