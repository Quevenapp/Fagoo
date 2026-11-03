import {StrictMode} from 'react';
import type {Root} from 'react-dom/client';
import {createBrowserRouter,RouterProvider} from 'react-router-dom';
import App from './App';
import {DemoStoreProvider} from './hooks/useDemoStore';
import {UnsavedChangesProvider} from './hooks/useUnsavedChanges';

export function mountErp(root:Root){
 const router=createBrowserRouter([{path:'*',element:<UnsavedChangesProvider><DemoStoreProvider><App/></DemoStoreProvider></UnsavedChangesProvider>}]);
 root.render(<StrictMode><RouterProvider router={router}/></StrictMode>);
}

import './fagoo-system.css';
