import Vue from 'vue';
import App from './App';
import './uni.scss';

App.mpType = 'app';

const app = new Vue({ ...App });
app.$mount();